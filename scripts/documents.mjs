import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const rootDocuments = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];

function visibleLinks(markdown) {
  let fence;
  const lines = [];
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    if (/^(?: {4}|\t)/.test(line)) continue;
    lines.push(line);
  }
  let content = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').replace(/(`+)[\s\S]*?\1/g, '');
  const references = new Map();
  const referenceKey = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
  content = content.replace(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+)).*$/gm, (_, label, angle, plain) => {
    const key = referenceKey(label);
    if (!references.has(key)) references.set(key, angle ?? plain);
    return '';
  });
  const targets = [];
  for (const match of content.matchAll(/!?\[([^\]]+)\](?:\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)|\[([^\]]*)\])?/g)) {
    const target = match[2] ?? match[3] ?? references.get(referenceKey(match[4] || match[1]));
    if (target !== undefined) targets.push({ target, navigable: !match[0].startsWith('!') });
  }
  return targets;
}

const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export function checkDocuments(project = process.cwd()) {
  const root = resolve(project);
  const errors = [];
  const folder = join(root, 'docs');
  const names = existsSync(folder) ? readdirSync(folder).filter(name => name.endsWith('.md')) : [];
  if (!names.length) errors.push('The public documentation directory is missing or empty.');
  const english = [...rootDocuments, ...names.filter(name => !name.endsWith('.ko.md')).map(name => `docs/${name}`)];
  for (const name of names.filter(name => name.endsWith('.ko.md'))) {
    if (!existsSync(join(folder, name.replace(/\.ko\.md$/, '.md')))) errors.push(`Missing English document: docs/${name.replace(/\.ko\.md$/, '.md')}`);
  }
  const pairs = english.map(path => ({ english: resolve(root, path), korean: resolve(root, path.replace(/\.md$/, '.ko.md')) }));
  const humanEnglish = new Set(pairs.map(pair => pathKey(pair.english)));
  let files = 0;
  let links = 0;
  for (const pair of pairs) {
    for (const [language, file, counterpart] of [['English', pair.english, pair.korean], ['Korean', pair.korean, pair.english]]) {
      const label = relative(root, file).replaceAll('\\', '/');
      if (!existsSync(file)) { errors.push(`Missing ${language} document: ${label}`); continue; }
      files++;
      const content = readFileSync(file, 'utf8');
      if (!content.trim()) errors.push(`Empty ${language} document: ${label}`);
      let hasLanguageLink = false;
      const navigation = new Set();
      for (const { target, navigable } of visibleLinks(content)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
        let path;
        try { path = resolve(dirname(file), decodeURIComponent(target.split('#')[0])); }
        catch { errors.push(`Invalid link in ${label}: ${target}`); continue; }
        const rel = relative(root, path);
        if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
          errors.push(`Link leaves the product in ${label}: ${target}`); continue;
        }
        links++;
        if (!existsSync(path)) errors.push(`Broken link in ${label}: ${target}`);
        const key = pathKey(path);
        if (navigable) navigation.add(key);
        if (navigable && key === pathKey(counterpart)) hasLanguageLink = true;
        if (language === 'Korean' && humanEnglish.has(key) && key !== pathKey(counterpart)) errors.push(`Korean guide links to English content in ${label}: ${target}`);
      }
      if (!hasLanguageLink) errors.push(`Missing language switch in ${label}`);
      if (pathKey(file) === pathKey(resolve(root, language === 'Korean' ? 'README.ko.md' : 'README.md'))) {
        for (const name of ['MANUAL', 'README']) {
          const target = `docs/${name}${language === 'Korean' ? '.ko.md' : '.md'}`;
          if (!navigation.has(pathKey(resolve(root, target)))) errors.push(`Missing entry link in ${label}: ${target}`);
        }
      }
    }
  }
  for (const language of ['English', 'Korean']) {
    const suffix = language === 'Korean' ? '.ko.md' : '.md';
    for (const name of ['MANUAL', 'README']) {
      const path = `docs/${name}${suffix}`;
      if (!existsSync(resolve(root, path))) errors.push(`Missing ${language} entry document: ${path}`);
    }
  }
  return { passed: errors.length === 0, pairs: pairs.length, files, links, errors };
}

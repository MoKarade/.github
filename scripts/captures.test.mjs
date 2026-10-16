import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MARQUEUR, capturer, commentaire, commenter, lirePages, nomImage, nomsUniques, publier, trouverCommentaire } from './captures.mjs';

test('nomImage : accueil, chemin, requête, caractères exotiques', () => {
  assert.equal(nomImage('/'), 'accueil');
  assert.equal(nomImage('/a/b'), 'a-b');
  assert.equal(nomImage('/Liste?page=2&x=é'), 'liste-page-2-x');
  assert.equal(nomImage('/'.padEnd(200, 'a')).length, 60);
});

test('nomsUniques : deux chemins qui donnent le même nom sont numérotés', () => {
  assert.deepEqual(nomsUniques(['/a/b', '/a-b', '/']), { '/a/b': 'a-b', '/a-b': 'a-b-2', '/': 'accueil' });
});

test('lirePages : liste propre, commentaires et doublons ignorés', () => {
  assert.deepEqual(lirePages('/\n# note\n  /liste?page=2 \n\n/\n'), ['/', '/liste?page=2']);
});

test('lirePages : refuse vide, hors app, remontée de dossier, trop de pages', () => {
  assert.throws(() => lirePages(''), /aucune page/);
  assert.throws(() => lirePages('https://evil.example/'), /invalide/);
  assert.throws(() => lirePages('//evil.example/x'), /invalide/);
  assert.throws(() => lirePages('/a/../b'), /invalide/);
  assert.throws(() => lirePages('relative'), /invalide/);
  assert.throws(() => lirePages(Array.from({ length: 13 }, (_, i) => `/p${i}`).join('\n')), /trop de pages/);
});

/** Faux navigateur : `reponses` associe un chemin à un statut (ou une erreur à lever). */
const fauxNavigateur = (reponses, ferme = { v: false }) => ({
  newContext: async () => ({
    newPage: async () => {
      let courant;
      return {
        goto: async (url) => {
          courant = new URL(url).pathname;
          const r = reponses[courant];
          if (r instanceof Error) throw r;
          return { status: () => r ?? 404 };
        },
        screenshot: async ({ path }) => writeFileSync(path, `png:${courant}`),
      };
    },
  }),
  close: async () => {
    ferme.v = true;
  },
});

test('capturer : image pour les pages saines, rien pour 404 et erreur, navigateur toujours fermé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-test-'));
  const ferme = { v: false };
  try {
    const meta = await capturer({
      urlBase: 'http://localhost:3000',
      pages: ['/', '/nouvelle', '/casse'],
      sortie: join(dir, 'avant'),
      lancerNavigateur: async () => fauxNavigateur({ '/': 200, '/casse': new Error('boom http://interne:9/secret') }, ferme),
    });
    assert.equal(meta['/'].fichier, 'accueil.png');
    assert.match(meta['/'].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(meta['/nouvelle'], { fichier: null, statut: 404 });
    assert.deepEqual(meta['/casse'], { fichier: null, statut: 0, erreur: 'navigation impossible' });
    assert.equal(readFileSync(join(dir, 'avant', 'accueil.png'), 'utf8'), 'png:/');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'avant', 'meta.json'), 'utf8')), meta);
    assert.equal(ferme.v, true);
    assert.doesNotMatch(JSON.stringify(meta), /secret|interne/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capturer : une page hors de l’app est refusée et le navigateur fermé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-test-'));
  const ferme = { v: false };
  try {
    await assert.rejects(
      capturer({ urlBase: 'http://localhost:3000', pages: ['//evil.example/x'], sortie: dir, lancerNavigateur: async () => fauxNavigateur({}, ferme) }),
      /hors de l'app/,
    );
    assert.equal(ferme.v, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commentaire : deux images par page, page ajoutée, identique, marqueur, sans production', () => {
  const avant = { '/': { fichier: 'accueil.png', statut: 200, sha256: 'aa' }, '/nouvelle': { fichier: null, statut: 404 }, '/x': { fichier: 'x.png', statut: 200, sha256: 'bb' } };
  const apres = { '/': { fichier: 'accueil.png', statut: 200, sha256: 'cc' }, '/nouvelle': { fichier: 'nouvelle.png', statut: 200, sha256: 'dd' }, '/x': { fichier: 'x.png', statut: 200, sha256: 'bb' } };
  const t = commentaire({ depot: 'MoKarade/A', pr: 7, sha: 'abcdef0123', pages: ['/', '/nouvelle', '/x'], avant, apres });
  assert.ok(t.startsWith(MARQUEUR));
  assert.match(t, /blob\/captures\/pr-7\/avant\/accueil\.png\?raw=true/);
  assert.match(t, /blob\/captures\/pr-7\/apres\/nouvelle\.png\?raw=true/);
  assert.match(t, /\| `\/nouvelle` \| _page absente \(HTTP 404\)_ \|/);
  assert.match(t, /\| `\/x` \(identique\) \|/);
  assert.doesNotMatch(t.split('\n').find((l) => l.startsWith('| `/` ')), /identique/);
  assert.match(t, /abcdef0/);
});

test('commentaire : côté « avant » absent ou illisible → non capturée', () => {
  const t = commentaire({ depot: 'MoKarade/A', pr: 7, sha: 'abc', pages: ['/'], avant: null, apres: { '/': { fichier: null, statut: 0, erreur: 'navigation impossible' } } });
  assert.match(t, /\| `\/` \| _non capturée_ \| _navigation impossible_ \|/);
});

test('trouverCommentaire : repère le commentaire marqué, ignore les autres', () => {
  assert.equal(trouverCommentaire([{ id: 1, body: 'salut' }, { id: 2, body: `${MARQUEUR}\nx` }]).id, 2);
  assert.equal(trouverCommentaire([{ id: 1, body: 'salut' }, { id: 3 }]), undefined);
});

test('commenter : pose puis met à jour, jamais deux commentaires', async () => {
  const appels = [];
  let existants = [[]];
  const gh = async (args, entree) => {
    appels.push({ args, entree });
    return args.includes('--slurp') ? JSON.stringify(existants) : '';
  };
  assert.equal(await commenter({ gh, depot: 'MoKarade/A', pr: 7, corps: 'c1' }), 'posé');
  assert.deepEqual(appels.at(-1).args.slice(0, 3), ['api', '--method', 'POST']);
  assert.deepEqual(JSON.parse(appels.at(-1).entree), { body: 'c1' });

  existants = [[{ id: 42, body: `${MARQUEUR} ancien` }]];
  assert.equal(await commenter({ gh, depot: 'MoKarade/A', pr: 7, corps: 'c2' }), 'mis à jour');
  assert.deepEqual(appels.at(-1).args.slice(0, 4), ['api', '--method', 'PATCH', 'repos/MoKarade/A/issues/comments/42']);
});

/** Un vrai dépôt git « distant » (nu) pour tester la publication de bout en bout, sans réseau. */
test('publier : crée la branche captures, la met à jour, garde l’historique, ne pousse pas deux fois la même chose', () => {
  const racine = mkdtempSync(join(tmpdir(), 'cap-pub-'));
  try {
    const distant = join(racine, 'distant.git');
    execFileSync('git', ['init', '-q', '--bare', distant]);
    const remote = `file://${distant}`;
    const sortie = (nom, contenu) => {
      const d = join(racine, nom);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'accueil.png'), contenu);
      writeFileSync(join(d, 'meta.json'), '{}');
      return d;
    };
    const lire = (fichier) => execFileSync('git', ['--git-dir', distant, 'show', `captures:${fichier}`], { encoding: 'utf8' });

    assert.deepEqual(publier({ remote, pr: 7, sha: 'aaaaaaa1', avant: sortie('a1', 'AVANT1'), apres: sortie('p1', 'APRES1') }), { pousse: true });
    assert.equal(lire('pr-7/avant/accueil.png'), 'AVANT1');
    assert.equal(lire('pr-7/apres/accueil.png'), 'APRES1');

    // même contenu : rien à pousser
    assert.deepEqual(publier({ remote, pr: 7, sha: 'aaaaaaa1', avant: sortie('a1', 'AVANT1'), apres: sortie('p1', 'APRES1') }), { pousse: false });

    // nouveau push de la PR + une autre PR : l'ancienne reste, l'historique grandit
    assert.deepEqual(publier({ remote, pr: 7, sha: 'bbbbbbb2', avant: sortie('a2', 'AVANT1'), apres: sortie('p2', 'APRES2') }), { pousse: true });
    assert.deepEqual(publier({ remote, pr: 8, sha: 'ccccccc3', avant: sortie('a3', 'A8'), apres: sortie('p3', 'P8') }), { pousse: true });
    assert.equal(lire('pr-7/apres/accueil.png'), 'APRES2');
    assert.equal(lire('pr-8/apres/accueil.png'), 'P8');
    const journal = execFileSync('git', ['--git-dir', distant, 'log', '--format=%s', 'captures'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(journal, ['captures de la PR #8 (ccccccc)', 'captures de la PR #7 (bbbbbbb)', 'captures de la PR #7 (aaaaaaa)']);
    assert.equal(existsSync(join(racine, 'distant.git')), true);
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});

test('publier : une erreur autre que « branche absente » remonte', () => {
  assert.throws(() => publier({ remote: 'file:///inexistant/depot.git', pr: 1, sha: 'abc', avant: '/nulle/part', apres: '/nulle/part' }));
});

// Preuves en retard (tâche MoKarade/.github#513, demande de Marc du 22/10/2026 : « ça devrait être fait automatiquement, mécaniquement »).
// Le relevé du PC (`outils/gantt-pc/build.py`) écrit `defauts-preuve.json` : les tâches fusionnées sans « Acceptée » depuis plus de 2 h, celles dont
// la preuve programmée est dépassée depuis plus d'1 h, les fermées sans preuve et les rouvertes par le garde-fou (`preuve-manquante`), hors tâches qui
// attendent Marc (`qui:marc`, elles ont le réveil « geste de Marc en retard »). Ce module décide quoi redire au Coordinateur, sans IA : un réveil par tâche et
// par motif, puis un autre toutes les 4 h tant que le défaut dure. Fonctions pures ; l'envoi est dans `filet-pc.mjs` (`tourPreuvesRetard`).
import { construireMotif } from './reveil-reacteur.mjs';

export const FENETRE_PREUVE_H = 4;
export const PREUVES_PAR_MESSAGE = 4;
export const DEFAUTS_PERIME_MIN = 30;
export const MOTIFS = {
  'fusionnée sans preuve depuis 2 h': 'fusionnée sans preuve',
  "preuve programmée dépassée depuis plus d'1 h": 'preuve programmée dépassée',
  'fermée sans preuve': 'fermée sans preuve',
  'preuve manquante': 'rouverte par le garde-fou',
};

const minutesEntre = (depuis, maintenant) => (maintenant.getTime() - Date.parse(depuis)) / 60_000;
const cle = (d) => `${d.ref}|${d.k}`;

/**
 * Décide quelles preuves en retard redire. Ne modifie pas son entrée.
 * @param defauts contenu de `defauts-preuve.json` : { calcule_le, defauts: [{ k, ref, marc? }] }
 * @param etat    { signale: { [ref|motif]: iso } } gardé d'un tour à l'autre
 * @returns { etat, reveils: [{ ref, k }], reste, raison }
 */
export function evaluerPreuvesRetard({ defauts, etat = {}, maintenant = new Date() }) {
  const limite = FENETRE_PREUVE_H * 60;
  const signale = Object.fromEntries(Object.entries(etat?.signale ?? {}).filter(([, t]) => minutesEntre(t, maintenant) < limite));
  const age = minutesEntre(defauts?.calcule_le ?? '', maintenant);
  if (!Number.isFinite(age) || age > DEFAUTS_PERIME_MIN) return { etat: { signale }, reveils: [], reste: 0, raison: 'defauts-preuve.json périmé' };
  const a_dire = (defauts.defauts ?? [])
    .filter((d) => d?.ref && MOTIFS[d.k] && !d.marc)
    .filter((d, i, tous) => tous.findIndex((e) => cle(e) === cle(d)) === i)
    .filter((d) => !signale[cle(d)]);
  const reveils = a_dire.slice(0, PREUVES_PAR_MESSAGE).map(({ ref, k }) => ({ ref, k }));
  for (const r of reveils) signale[cle(r)] = maintenant.toISOString();
  return { etat: { signale }, reveils, reste: Math.max(0, a_dire.length - reveils.length), raison: reveils.length ? '' : 'aucune preuve en retard à redire' };
}

/** Le texte du réveil, au format `RÉACTEUR : preuve en retard : …` ; `reste` : tâches dites au tour suivant. */
export function motifDesPreuves(reveils, reste = 0) {
  const liste = reveils.map((r) => `${r.ref} (${MOTIFS[r.k]})`).join(' ; ');
  return construireMotif([`preuve en retard : ${liste}${reste ? ` ; +${reste} autre(s) au prochain tour` : ''}`]);
}

/** Après un réveil raté, on oublie le signalement pour que le tour suivant réessaie. */
export function annulerPreuves(etat, reveils) {
  const signale = { ...(etat?.signale ?? {}) };
  for (const r of reveils) delete signale[cle(r)];
  return { signale };
}

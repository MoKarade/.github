// Qui peut écrire une preuve ou un relevé (tâche MoKarade/.github#836). Sur un dépôt public, tout compte GitHub peut commenter une issue :
// `user.type === 'User'` ne dit pas que le commentaire vient de Marc, de ses fils ou du PC (tous écrivent avec son compte, donc OWNER).
// `author_association` est toujours fourni par l'API GitHub ; son absence ne se rencontre que dans des données synthétiques, jamais en production.
export const ASSOCIATIONS_DE_CONFIANCE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Vrai si le commentaire vient d'un compte de la maison. Un tiers (NONE, CONTRIBUTOR, FIRST_TIMER…) rend faux. */
export const estDeConfiance = (commentaire) => commentaire != null && (commentaire.author_association === undefined || ASSOCIATIONS_DE_CONFIANCE.has(commentaire.author_association));

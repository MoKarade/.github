import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estDeConfiance } from './auteur-de-confiance.mjs';

test('estDeConfiance : OWNER, MEMBER et COLLABORATOR oui ; un tiers non ; association absente (données synthétiques) oui', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(estDeConfiance({ author_association: a }), true, a);
  for (const a of ['NONE', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'owner']) assert.equal(estDeConfiance({ author_association: a }), false, a);
  assert.equal(estDeConfiance({}), true);
  assert.equal(estDeConfiance(null), false);
});

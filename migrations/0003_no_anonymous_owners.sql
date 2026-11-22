-- Every owner needs an account (RLM-434). The service no longer issues or accepts anonymous owner
-- tokens: the routes are gone and only WorkOS access tokens authenticate an owner.

-- Revoke every owner token, claimed ones too: a copy left on another machine or in a backup of
-- cloud.json stops working. An account's own owner never had a usable token (its hash is of random
-- bytes nobody keeps), so this changes nothing for it. randomblob() runs once per row.
UPDATE owners SET token_hash = lower(hex(randomblob(32)));

-- Owners no account holds are blocked, and their pages taken down: they answer 410 Gone to
-- reviewers and owners alike. Their D1 rows stay, so page_objects keeps naming the blobs a takedown
-- has to clean up.
UPDATE pages SET taken_down = 1 WHERE owner_id IN (SELECT id FROM owners WHERE user_id IS NULL);
DELETE FROM grants WHERE page_id IN (SELECT id FROM pages WHERE owner_id IN (SELECT id FROM owners WHERE user_id IS NULL));
UPDATE owners SET blocked = 1 WHERE user_id IS NULL;

-- Where the owner's local hub files a page (RLM-458): the project (folder) name and the page's path in it,
-- sent by `publish` from sync v2. D1 only: the cloud hub groups an owner's pages by `project`. They are not in the
-- `page` row reviewers receive. NULL: published before this, or by a CLI that did not send them (Ungrouped).
ALTER TABLE pages ADD COLUMN project TEXT;
ALTER TABLE pages ADD COLUMN rel_path TEXT;

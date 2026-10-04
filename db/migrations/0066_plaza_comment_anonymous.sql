-- Tree-hole comments could not be anonymous: the table had no column and the
-- public feed always joined the commenter's Telegram identity onto every row,
-- so a signed-in user's numeric Telegram id and username were visible to every
-- visitor the moment they commented. Comments now default to anonymous, which
-- matches the "可以匿名" promise the plaza UI already made for posts.
ALTER TABLE plaza_post_comments ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 1;

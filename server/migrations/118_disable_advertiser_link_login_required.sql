-- An active 업체 전용 링크 is its own bearer credential.  Existing links must
-- therefore never send a viewer to an additional login screen.
UPDATE trackb_advertiser_links
   SET login_required = FALSE
 WHERE login_required IS DISTINCT FROM FALSE;

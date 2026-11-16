-- 0098 · 全库索引对账（reconcile）。
--
-- 迁移记录按文件名记账、不校验内容：0034/0038 这类 rename-dance 重建表迁移
-- 用 DROP TABLE 换新表时连带删除旧表全部索引，重建清单只补回一部分——
-- f4a560c5 客户库实测 d1_migrations 记录 0004 已应用而 0004 里的
-- idx_responses_survey_id 不存在。本迁移把全部迁移执行后的终态索引逐条
-- CREATE IF NOT EXISTS 重申一遍（幂等、按名排序），一次性消除所有部署的
-- 历史漂移。
--
-- 生成方式：node scripts/gen-reconcile-migration.mjs——把全部迁移在真实
-- SQLite 里执行后从终态 sqlite_master 提取（不是解析迁移文件文本：过渡表
-- 与已 DROP 表的索引照抄会在终态 schema 上失败）。普通迁移变更后重跑本
-- 脚本再生成，勿手工编辑本文件。维护期运行时自愈的前置清单见
-- src/services/database-maintenance.service.ts 的 MAINTENANCE_INDEXES，两份
-- 清单语义不同：这里管全库一次性对账，那里管每日维护的读写路径自愈。
--
-- 回滚：本迁移只新增索引；DROP 对应索引名即可（一般无需回滚）。

CREATE INDEX IF NOT EXISTS idx_admin_login_consumptions_consumed_at
  ON admin_login_consumptions(consumed_at);
CREATE INDEX IF NOT EXISTS idx_answer_media_answer_id
  ON answer_media(answer_id);
CREATE INDEX IF NOT EXISTS idx_answer_media_asset_id
  ON answer_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_id ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_question_response
  ON answers(question_id, response_id);
CREATE INDEX IF NOT EXISTS idx_answers_response_id ON answers(response_id);
CREATE INDEX IF NOT EXISTS idx_answers_response_id_id
  ON answers(response_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action
  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_id
  ON audit_logs(action, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id
  ON audit_logs(entity_type, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_card_templates_enabled
  ON card_templates(enabled, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_coin_accounts_user ON coin_accounts(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coin_txn_hash ON coin_transactions(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_coin_txn_kind_ref ON coin_transactions(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_creator_invites_expires_at ON creator_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_creator_trial_grants_expires_at
  ON creator_trial_grants(expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_deployments_license ON customer_deployments(license_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_deployments_status ON customer_deployments(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_tasks_deployment ON deployment_tasks(deployment_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_deployment_tasks_queue ON deployment_tasks(status, requested_at ASC);
CREATE INDEX IF NOT EXISTS idx_draws_drawer_day ON note_draws(drawer_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_email_sessions_account ON email_sessions(account_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_ending_unlocks_survey ON ending_unlocks(survey_id, participant_hash);
CREATE INDEX IF NOT EXISTS idx_export_jobs_retention
  ON export_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_export_jobs_status_created
  ON export_jobs(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_feature_access_grants_feature_version
  ON feature_access_grants(feature, setting_version);
CREATE INDEX IF NOT EXISTS idx_gacha_items_pool ON gacha_pool_items(pool_id, active);
CREATE INDEX IF NOT EXISTS idx_gacha_pulls_hash ON gacha_pulls(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_gacha_pulls_pool ON gacha_pulls(pool_id, participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_asset
  ON gallery_profile_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_response
  ON gallery_profile_media(response_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_gallery_profile_media_source_asset
  ON gallery_profile_media(source_asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_profile_media_unique
  ON gallery_profile_media(response_id, source_asset_id)
  WHERE source_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_processing_lease
  ON identity_card_jobs(status, processing_started_at, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_retention
  ON identity_card_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_card_jobs_status
  ON identity_card_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_back_asset
  ON identity_profiles(back_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_background_asset
  ON identity_profiles(background_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_card_asset
  ON identity_profiles(card_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_front_asset
  ON identity_profiles(front_asset_id);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_gallery
  ON identity_profiles(gallery_published, id DESC);
CREATE INDEX IF NOT EXISTS idx_identity_profiles_user ON identity_profiles(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_image_generator_backgrounds_asset
  ON image_generator_backgrounds(asset_id);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_generator
  ON image_generator_jobs(generator_id);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_report_result
  ON image_generator_jobs(report_result_id);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_retention
  ON image_generator_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_image_generator_jobs_status ON image_generator_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_image_generator_questions_generator ON image_generator_questions(generator_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_image_generators_draft_retention
  ON image_generators(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_image_generators_report_background_asset
  ON image_generators(report_background_asset_id);
CREATE INDEX IF NOT EXISTS idx_image_generators_status ON image_generators(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_image_generators_template
  ON image_generators(template_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_license
  ON software_license_activations(license_id, deactivated_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_content_hash ON media_assets(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_created_at
  ON media_assets(created_at, id);
CREATE INDEX IF NOT EXISTS idx_media_assets_scope ON media_assets(asset_scope, id);
CREATE INDEX IF NOT EXISTS idx_media_assets_temp_expiry
  ON media_assets(storage_kind, expires_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_url ON media_assets(url);
CREATE INDEX IF NOT EXISTS idx_media_refs_asset ON media_refs(asset_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON note_messages(thread_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_owner_active ON notes(owner_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_notes_pool ON notes(status, expires_at, id);
CREATE INDEX IF NOT EXISTS idx_notifications_participant ON notifications(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_option_media_asset_id
  ON option_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_option_media_option_id ON option_media(question_option_id);
CREATE INDEX IF NOT EXISTS idx_participant_achievements_hash
  ON participant_achievements(participant_hash, unlocked_at DESC);
CREATE INDEX IF NOT EXISTS idx_participant_links_user ON participant_links(user_id);
CREATE INDEX IF NOT EXISTS idx_permissions_survey_id ON survey_permissions(survey_id);
CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON survey_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_phl_canonical ON participant_hash_links(canonical_hash);
CREATE INDEX IF NOT EXISTS idx_plaza_post_comments_post
  ON plaza_post_comments(post_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_plaza_post_comments_user
  ON plaza_post_comments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaza_posts_active_feed
  ON plaza_posts(status, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plaza_posts_deleted_at
  ON plaza_posts(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plaza_posts_feed ON plaza_posts(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_plaza_posts_image_asset ON plaza_posts(image_asset_id);
CREATE INDEX IF NOT EXISTS idx_plaza_posts_topic ON plaza_posts(topic, id DESC);
CREATE INDEX IF NOT EXISTS idx_plaza_posts_user_status
  ON plaza_posts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_profile_shares_hash ON profile_shares(participant_hash);
CREATE INDEX IF NOT EXISTS idx_publication_targets_default ON publication_targets(enabled, is_default, id);
CREATE INDEX IF NOT EXISTS idx_question_media_asset_id
  ON question_media(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_question_media_question_id ON question_media(question_id);
CREATE INDEX IF NOT EXISTS idx_question_options_question_id ON question_options(question_id);
CREATE INDEX IF NOT EXISTS idx_question_options_question_order
  ON question_options(question_id, "order", id);
CREATE INDEX IF NOT EXISTS idx_questions_order ON survey_questions(survey_id, "order");
CREATE INDEX IF NOT EXISTS idx_questions_survey_id ON survey_questions(survey_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start
  ON rate_limits(window_start);
CREATE UNIQUE INDEX IF NOT EXISTS idx_render_jobs_active
  ON render_jobs(result_profile_id, template_id, template_version)
  WHERE status IN ('queued', 'processing');
CREATE INDEX IF NOT EXISTS idx_render_jobs_retention
  ON render_jobs(status, completed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_status_created_at
  ON render_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_template
  ON render_jobs(template_id);
CREATE INDEX IF NOT EXISTS idx_report_deliveries_status
  ON report_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_report_results_generator_user ON report_results(generator_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_results_retention
  ON report_results(created_at, id);
CREATE INDEX IF NOT EXISTS idx_report_shares_participant ON report_shares(participant_hash);
CREATE INDEX IF NOT EXISTS idx_report_templates_created_by
  ON report_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_report_templates_deleted_at
  ON report_templates(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_active_participant
  ON survey_responses(survey_id, participant_hash) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_responses_participant
  ON survey_responses(survey_id, participant_hash);
CREATE INDEX IF NOT EXISTS idx_responses_participant_hash
  ON survey_responses(participant_hash);
CREATE INDEX IF NOT EXISTS idx_responses_started_at
  ON survey_responses(started_at);
CREATE INDEX IF NOT EXISTS idx_responses_status_started
  ON survey_responses(status, started_at);
CREATE INDEX IF NOT EXISTS idx_responses_status_updated
  ON survey_responses(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_responses_survey_status_completed
  ON survey_responses(survey_id, status, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_responses_survey_status_id
  ON survey_responses(survey_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_responses_user_status_id
  ON survey_responses(user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_result_profiles_survey_id
  ON result_profiles(survey_id);
CREATE INDEX IF NOT EXISTS idx_series_follows_series ON series_follows(series_id);
CREATE INDEX IF NOT EXISTS idx_showcase_items_active_person
  ON showcase_items(person_id, sort_order, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_items_deleted_at
  ON showcase_items(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_items_media_asset ON showcase_items(media_asset_id);
CREATE INDEX IF NOT EXISTS idx_showcase_items_person
  ON showcase_items(person_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_showcase_persons_active_feed
  ON showcase_persons(published, feature_rank, sort_order, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_persons_admin_cursor_all
  ON showcase_persons(created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_persons_admin_legacy_feed
  ON showcase_persons(feature_rank DESC, sort_order ASC, id ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_persons_deleted_at
  ON showcase_persons(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_showcase_persons_feed
  ON showcase_persons(published, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_showcase_persons_owner
  ON showcase_persons(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_showcase_persons_public_cursor
  ON showcase_persons(created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND published = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_showcase_persons_response
  ON showcase_persons(response_id)
  WHERE response_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_software_licenses_customer
  ON software_licenses(customer_name);
CREATE INDEX IF NOT EXISTS idx_software_licenses_status
  ON software_licenses(status);
CREATE INDEX IF NOT EXISTS idx_software_releases_released_at
  ON software_releases(released_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_dedup
  ON submissions(participant_hash, content_hash)
  WHERE status NOT IN ('withdrawn', 'removed', 'rejected');
CREATE INDEX IF NOT EXISTS idx_submissions_hash ON submissions(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_survey_pages_survey
  ON survey_pages(survey_id, "order", id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_gallery
  ON survey_responses(gallery_published, gallery_published_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_responses_gallery_cover_source
  ON survey_responses(gallery_cover_source_asset_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_user_status
  ON survey_responses(user_id, status);
CREATE INDEX IF NOT EXISTS idx_survey_unlocks_hash ON survey_unlocks(participant_hash, id DESC);
CREATE INDEX IF NOT EXISTS idx_survey_versions_survey
  ON survey_versions(survey_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_category ON surveys(category_id, status);
CREATE INDEX IF NOT EXISTS idx_surveys_cover_media
  ON surveys(cover_media_id);
CREATE INDEX IF NOT EXISTS idx_surveys_deleted_at
  ON surveys(deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_draft_retention
  ON surveys(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_surveys_owner_id ON surveys(owner_id);
CREATE INDEX IF NOT EXISTS idx_surveys_series ON surveys(series_id, series_order);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status);
CREATE INDEX IF NOT EXISTS idx_surveys_status_published
  ON surveys(status, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_updated_at
  ON surveys(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_items_pack ON task_items(pack_id, enabled, persona, mode);
CREATE INDEX IF NOT EXISTS idx_task_items_pack_sort
  ON task_items(pack_id, enabled, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_task_packs_game_type ON task_packs(game_type);
CREATE INDEX IF NOT EXISTS idx_task_runs_leaderboard ON task_runs(pack_id, mode, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_participant ON task_runs(participant_hash, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_user_pack_mode
  ON task_runs(user_id, pack_id, mode, status, score DESC);
CREATE INDEX IF NOT EXISTS idx_telegram_update_dedup_received_at
  ON telegram_update_dedup(received_at);
CREATE INDEX IF NOT EXISTS idx_telegram_update_dedup_status_received
  ON telegram_update_dedup(status, received_at);
CREATE INDEX IF NOT EXISTS idx_threads_drawer ON note_threads(drawer_hash, last_message_at);
CREATE INDEX IF NOT EXISTS idx_user_tags_tag ON user_tags(tag);
CREATE INDEX IF NOT EXISTS idx_user_tags_user ON user_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_users_banned_at ON users(banned_at, id);
CREATE INDEX IF NOT EXISTS idx_users_bot_started_at
  ON users(bot_started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_name ON users(first_name, last_name);
CREATE INDEX IF NOT EXISTS idx_users_updated_at
  ON users(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_visual_template_assets_asset
  ON visual_template_assets(asset_id);
CREATE INDEX IF NOT EXISTS idx_visual_template_assets_template
  ON visual_template_assets(template_id, template_version);
CREATE INDEX IF NOT EXISTS idx_visual_template_versions_template_id
  ON visual_template_versions(template_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_visual_templates_draft_retention
  ON visual_templates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_visual_templates_owner_id
  ON visual_templates(owner_id);
CREATE INDEX IF NOT EXISTS idx_visual_templates_survey_id
  ON visual_templates(survey_id);
CREATE INDEX IF NOT EXISTS idx_web_comments_submission
  ON web_submission_comments(submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_submissions_status
  ON web_submissions(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_web_submissions_viewer
  ON web_submissions(viewer_token, id DESC);
CREATE INDEX IF NOT EXISTS idx_web_threads_submission
  ON web_submission_threads(submission_id, id);

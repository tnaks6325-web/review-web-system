require('dotenv').config();
const app = require('./src/app');
const { startCronJobs } = require('./src/jobs/cron');
const { startSmartBuild } = require('./src/services/smartBuild.service');
const { logger } = require('./src/utils/logger');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const readOnlyPreview = process.env.READ_ONLY_MODE === 'true';

// ── 마이그레이션 안전장치(방어 D2·D7) ──
// D2: 종전 에러 "메시지" 부분일치(duplicate/already exists)는 23505(duplicate key = 데이터 마이그레이션 실패)까지
//     '적용됨'으로 영구 기록해 재시도를 영구 소실시킨다 → 중복 "객체" PG 에러코드로만 판정하고,
//     그 외 실패는 미기록(= 다음 부팅 재시도) + 아래 프리플라이트가 부팅 가부를 결정한다.
// D7: 오픈 러시 중 재배포 시 ALTER(ACCESS EXCLUSIVE)가 락 큐 선두에 서면 recruit_campaigns 를 읽는
//     모든 요청(list·apply·확정)이 동시 정지한다 → 세션 lock_timeout 으로 "기다리지 않고 포기 후 재시도".
const DUP_OBJECT_CODES = new Set(['42701', '42P07', '42710', '42P06', '42723']); // column/table/object/schema/function
const MIG_LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT || '5s';
const MIG_STMT_TIMEOUT = process.env.MIGRATION_STATEMENT_TIMEOUT || '120s';
const MIG_LOCK_RETRIES = 3;

// 실행 코드가 요구하는 컬럼(없으면 사용자 대면 500). 마이그레이션이 실패해도 listen 하면
// /health 는 통과하고 해당 기능만 42703 으로 죽어 "무신호 전면장애"가 된다.
const REQUIRED_SCHEMA = [
  ['campaign_applications', 'owner_phone8'],       // 063 — apply INSERT·my-status·관제
  ['recruit_campaigns', 'multi_account_mode'],     // 063 — 공개 /list 명시 SELECT
  ['recruit_campaigns', 'multi_daily_limit'],      // 063 — apply 게이트·공고 저장
  ['recruit_campaigns', 'sub_hold_ttl_min'],       // 063 — 공개 /list 명시 SELECT
  ['campaign_applications', 'review_fee_snapshot'],// 082 — apply INSERT(없으면 참여 전면 42703)·리뷰어 참여내역
  ['order_submissions', 'review_fee_snapshot'],    // 082 — 홀드확정 전파·review-earnings(없으면 금액이 조용히 0원)
  ['trackb_advertiser_links', 'login_required'],   // 083 — 광고주 링크 로그인 게이트·업체관리 링크/계정 카드
  ['recruit_campaigns', 'reviewer_hidden'],        // 085 — 공개 /list WHERE 절(없으면 리뷰어 공고목록 전면 42703)
  ['recruit_campaigns', 'transfer_bank'],         // 086 — 공고 create/update INSERT·SET 목록(없으면 공고 발행·수정 전면 42703)
  ['recruit_campaigns', 'transfer_memo'],         // 086 — 위와 같은 문장에 들어가므로 함께 막아야 한다
  ['recruit_campaigns', 'review_type'],           // 087 — 공고 create/update INSERT·SET 목록(없으면 공고 발행·수정 전면 42703)
  ['work_orders', 'sales_id'],                    // 088 — _insertWorkOrder INSERT 목록(없으면 인트라넷 오더 접수 전면 42703)
  ['work_orders', 'guide_images'],                // 090 — _insertWorkOrder INSERT 목록(없으면 인트라넷 오더 접수 전면 42703)
  ['work_orders', 'source_review_order_id'],      // 102 — 원본 오더 식별자(중복 수신 방지)
  ['work_orders', 'source_revision'],             // 102 — 원본 수정 버전
  ['work_orders', 'intake_idempotency_key'],      // 102 — 네트워크 재시도 키
  ['work_orders', 'intranet_advertiser_id'],      // 102 — 원본 광고주 식별자
  ['work_orders', 'intranet_advertiser_name'],    // 102 — 원본 광고주명 스냅샷
  ['work_orders', 'intranet_advertiser_contact'], // 102 — 원본 광고주 연락처 스냅샷
  ['work_orders', 'intranet_advertiser_business_number'], // 102 — 원본 사업자번호 스냅샷
  ['advertisers', 'intranet_advertiser_id'],     // 103 — 인트라넷 광고주 원본 키
  ['portal_works', 'work_order_id'],             // 103 — 포털 작업의 원 작업오더 키
  ['work_orders', 'advertiser_id'],              // 103 — 접수된 리뷰웹 광고주 연결
  ['review_inspections', 'resolution'],           // 092 — 리뷰검수 목록 SELECT·확인 UPDATE(없으면 리뷰검수 탭 전면 42703)
  ['tab_configs', 'inspect_product_aliases'],     // 092 — 기대값 조회·별칭 학습(조회는 fail-soft지만 대조가 조용히 죽는다)
  ['tab_configs', 'sheetless'],                   // 096 — 크론 단속·장부 생성기·접수 업서트(없으면 무시트 경로 전면 42703)
  ['work_orders', 'skip_weekends'],               // 097 — _insertWorkOrder INSERT 목록(없으면 인트라넷 오더 접수 전면 42703)
  ['work_orders', 'holidays'],                    // 097 — 위와 같은 문장에 들어가므로 함께 막아야 한다
  ['work_orders', 'review_type_mix'],             // 107 — 인트라넷 혼합 리뷰 수량의 원장 보존·모집공고 프리필
  ['recruit_campaigns', 'skip_weekends'],         // 104 — public weekend publication guard
  ['participant_edits', 'wrote_row_json'],        // 130 — 셀 편집 INSERT 목록(없으면 작업보드 편집 전면 42703)
  ['tab_configs', 'ledger_dirty_at'],             // 130 — 편집 tx 의 장부 재생성 예약(dirty 마킹)
  ['recruit_campaigns', 'cash_receipt_required'], // 105 — 모집공고 현금영수증 직접 설정·공개 안내
  ['recruit_campaigns', 'review_type_mix'],       // 106 — 혼합 리뷰 유형별 모집 수량(발행 전 합계 검증)
  ['campaign_options', 'review_type_mix'],        // 109 — 옵션별 혼합 리뷰 수량(옵션 정원별 검증)
  ['recruit_campaigns', 'carry_mode'],            // 098 — 공고 create/update INSERT·SET + 공개 /list 명시 SELECT(없으면 발행·수정·목록 42703)
  // 099 — 체험단 종류(리뷰/블로그) 축. 셋 다 INSERT·SET 목록에 들어가므로 하나라도 없으면
  //   ① 인트라넷 오더 접수 ② 작업오더 접수(tab_configs 업서트) ③ 공고 발행·수정이 전면 42703.
  ['work_orders', 'work_kind'],
  ['tab_configs', 'work_kind'],
  ['recruit_campaigns', 'work_kind'],
  // 101 — 블로그URL(블로그 주소). 둘 다 INSERT 목록에 들어가므로 하나라도 없으면
  //   ① 블로그 공고 참여(apply) ② 구매양식 제출(주문 원장 INSERT)이 전면 42703.
  ['campaign_applications', 'blog_url'],
  ['order_submissions', 'blog_url'],
  ['payment_batch_items', 'result_status'],       // 100 — 이체결과 반영 UPDATE SET 목록(없으면 반영이 통째로 42703)
  ['payment_batches', 'applied_at'],              // 100 — 위와 같은 트랜잭션에 들어가므로 함께 막아야 한다
  ['payment_batches', 'board_recorded_count'],    // 110 actual workboard write outcome
  ['payment_batches', 'board_queued_count'],      // 110 queued writes are not records yet
  ['payment_result_uploads', 'file_blob'],
  ['campaign_popular_prerequisites', 'priority'], // 115 인기공고 선행참여 우선순위
  // 126 — 만료 자동 취소확정 마커. 스윕 UPDATE·되살리기 판정이 이 컬럼을 읽으므로
  //   없으면 매분 스윕이 42703 으로 죽어 **만료 마킹까지 함께 멈춘다**.
  ['campaign_applications', 'dismissed_by'],
];

async function _runOneMigration(pool, sql) {
  const client = await pool.connect();
  let broken = false;
  try {
    // set_config = 파라미터 바인딩 가능(SET 은 불가) → 문자열 보간 주입면 제거.
    // is_local=false(세션 단위)라 파일 내부의 명시 BEGIN(025·045)에서도 유효하다.
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [MIG_LOCK_TIMEOUT]);
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [MIG_STMT_TIMEOUT]);
    await client.query(sql);
  } catch (err) {
    broken = true;                                   // 파일 내부 BEGIN 이 열린 채 실패했을 수 있음
    throw err;
  } finally {
    if (broken) {
      try { await client.query('ROLLBACK'); } catch (_) { /* 이미 정리됨 */ }
      client.release(true);                          // 오염 의심 커넥션은 풀에 되돌리지 않고 폐기
    } else {
      try { await client.query('RESET ALL'); client.release(); }
      catch (_) { client.release(true); }
    }
  }
}

/** 필수 스키마 프리플라이트 — 누락이면 부팅 거부.
 *  ★ 거부가 안전한 이유: Railway 는 새 배포가 기동 실패하면 직전 배포를 유지한다. 구버전 코드는
 *    이 컬럼들을 참조하지 않으므로 라이브는 정상 동작을 계속한다(진짜 fail-closed).
 *  ★ "확인 불가"(DB 일시장애)와 "없음"은 구분 — 조회 자체가 실패하면 부팅을 막지 않는다(크래시루프 방지). */
async function assertSchemaReady() {
  const pool = require('./src/db/pool');
  let rows;
  try {
    const tuples = REQUIRED_SCHEMA.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',');
    ({ rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name, column_name) IN (${tuples})`,
      REQUIRED_SCHEMA.flat()));
  } catch (err) {
    logger.warn(`[migrate] 스키마 프리플라이트 조회 실패(부팅 계속): ${err.message}`);
    return;
  }
  const have = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  const missing = REQUIRED_SCHEMA.map(([t, c]) => `${t}.${c}`).filter(k => !have.has(k));
  if (!missing.length) return;
  logger.error(`[migrate] ❌ 필수 스키마 누락 → 부팅 거부: ${missing.join(', ')}`);
  logger.error('[migrate]    조치: 마이그레이션 로그 확인 후 재배포 / 긴급 우회: ALLOW_SCHEMA_DRIFT=1');
  if (process.env.ALLOW_SCHEMA_DRIFT === '1') {
    logger.warn('[migrate] ⚠️ ALLOW_SCHEMA_DRIFT=1 — 누락을 무시하고 계속(해당 기능은 500 발생)');
    return;
  }
  process.exit(1);
}

// ── 서버 시작 전 자동 마이그레이션 (이력 추적) ──
async function runMigrations() {
  const pool = require('./src/db/pool');
  const migrationsDir = path.resolve(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  // 마이그레이션 이력 테이블 생성 (최초 1회)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 이미 적용된 마이그레이션 조회
  const { rows: applied } = await pool.query('SELECT filename FROM _migrations');
  const appliedSet = new Set(applied.map(r => r.filename));

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let newCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      continue; // 이미 적용됨 → 건너뛰기
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    let applied = false;
    for (let attempt = 1; attempt <= MIG_LOCK_RETRIES && !applied; attempt++) {
      try {
        await _runOneMigration(pool, sql);
        await pool.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        logger.info(`[migrate] ✅ ${file} 적용 완료`);
        newCount++; applied = true;
      } catch (err) {
        if (DUP_OBJECT_CODES.has(err.code)) {
          // 이미 존재하는 "객체" — IF NOT EXISTS 누락 패턴. 적용 완료로 기록.
          await pool.query('INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
          logger.info(`[migrate] ⏭ ${file} (이미 적용됨, code=${err.code})`);
          applied = true;
        } else if (err.code === '55P03' || err.code === '57014') { // lock_not_available / statement_timeout
          logger.warn(`[migrate] ⏳ ${file} 락 대기 초과(${attempt}/${MIG_LOCK_RETRIES}) — 미기록, 재시도`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        } else {
          // ★ 미기록 = 다음 부팅 재시도. 부팅 가부는 assertSchemaReady 가 결정한다.
          logger.error(`[migrate] ❌ ${file}: [${err.code || 'ERR'}] ${err.message}`);
          break;
        }
      }
    }
  }

  if (newCount > 0) {
    logger.info(`[migrate] 🎉 ${newCount}개 마이그레이션 새로 적용 (총 ${files.length}개)`);
  } else {
    logger.info(`[migrate] 모든 마이그레이션 적용 완료 (${files.length}개)`);
  }
}

// ── 서버 시작 ──
(async () => {
  if (!readOnlyPreview) {
    try {
      await runMigrations();
  } catch (err) {
    logger.warn(`[migrate] 마이그레이션 오류 (프리플라이트가 부팅 가부 판정): ${err.message}`);
  }
    await assertSchemaReady();   // ★ 필수 컬럼 누락이면 여기서 종료 — listen 하지 않는다(무신호 500 방지)
  } else {
    logger.info('[read-only-preview] migration and schema preflight skipped');
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    // ★ 서버 타임아웃 설정 — 이미지 업로드 등 대용량 요청 대응 (3분)
    server.timeout = 180000;           // 요청 처리 최대 180초
    server.keepAliveTimeout = 65000;   // keep-alive 65초 (ALB 기본 60초보다 길게)
    server.headersTimeout = 70000;     // 헤더 수신 타임아웃

    logger.info(`✅ 리뷰웹시스템 API 서버 시작: http://0.0.0.0:${PORT}`);
    logger.info(`   환경: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`   DB: ${process.env.DATABASE_URL ? '연결됨' : '❌ DATABASE_URL 미설정'}`);
    logger.info(`   Google: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? '설정됨' : '⚠️ 미설정'}`);

    // 스케줄러 시작 (GAS 트리거 대체)
    if (process.env.NODE_ENV === 'production' && !readOnlyPreview) {
      startCronJobs();
      logger.info('✅ 인덱스 빌드 스케줄러 시작됨');
    } else {
      logger.info('⏭ 개발 환경 — 기존 CRON 스케줄러 비활성화 (수동 빌드 사용)');
    }

    // ★ 스마트 빌드 스케줄러 시작 (기본 ON — 근실시간 변경감지 유일 폴러).
    //   SMART_BUILD_DISABLED=1 이면 코드레벨 미기동(env 킬스위치). 미설정=기존 동작(가산적·롤백가능).
    //   startSmartBuild는 app_settings.smart_build_paused_until을 읽어 관리자 pause를 부팅 복원(async)한다.
    //   listen 콜백은 async가 아니므로 fire-and-forget(.then/.catch) — 부팅복원 실패는 비치명.
    if (readOnlyPreview) {
      logger.info('[read-only-preview] smart build scheduler skipped');
    } else if (process.env.SMART_BUILD_DISABLED === '1') {
      logger.warn('⏸ SMART_BUILD_DISABLED=1 — 스마트 빌드 스케줄러 미기동(env 킬스위치). 근실시간 인덱스 갱신 없음(전체빌드만).');
    } else {
      startSmartBuild()
        .then(() => logger.info('✅ 스마트 빌드 스케줄러 시작됨 (5분 주기, Drive+Sheets API)'))
        .catch(err => logger.error(`[smartBuild] 시작 실패: ${err.message}`));
    }

    // ★ 제출열 오탐지 핫픽스(#427, #435) 배포 직후 1회성 강제 전체 재빌드.
    //   원인 ①(8/3, #427): SUBMIT_KEYWORDS의 넓은 catch-all '리뷰'가 우선탐지를 무력화해
    //   '리뷰가이드' 같은 작업지시 열이 실제 '리뷰제출'열보다 먼저 잡혀 그 탭 참여자 전원이
    //   제출완료로 오판정됐다. 원인 ②(8/4, #435): ①의 수정이 만든 회귀 — 완료열이 접미사 없이
    //   '리뷰' 단독(또는 '리뷰캡쳐본' 등 완료신호 단어 없는 파생명)뿐인 시트에서 최후수단 단계가
    //   이름열 제외패턴 없이 '주문자제출'(이름열, '제출' 포함)을 먼저 집어 같은 증상이 재발했다.
    //   코드 수정은 "다음에 새로 파싱할 때"만 적용되는데, review_index는 시트 checksum이 그대로면
    //   정기 빌드(스마트/09·15시/04시)가 그 탭을 계속 건너뛰므로(변경 없음=재파싱 불필요 최적화)
    //   코드만 배포해서는 이미 저장된 잘못된 is_submitted 값이 저절로 정정되지 않는다.
    //   → forceFullRebuild=true(체크섬 무시)로 전 탭 1회 강제 재파싱해 즉시 정정한다.
    //   ★ 1회성 가드(app_settings, 057과 동일 패턴): 재배포마다 반복 실행되면 Sheets API 쿼터를
    //     불필요하게 소모하므로 최초 1회만 수행한다. 키를 8/4 라운드로 갱신해 ①만 반영됐던
    //     배포에서도 ②까지 포함해 다시 한번 강제 재빌드되게 한다(8/3 플래그는 재사용하지 않음).
    if (process.env.NODE_ENV === 'production' && !readOnlyPreview) {
      (async () => {
        const pool = require('./src/db/pool');
        try {
          const { rows } = await pool.query(
            "SELECT 1 FROM app_settings WHERE key = 'submitcol_fix_20260804_rebuilt'");
          if (rows.length) return;
          logger.info('[boot] 제출열 오탐지 핫픽스 — 강제 전체 재빌드 시작(1회성, #427+#435)');
          const { buildIndexSmart } = require('./src/services/indexBuilder.service');
          const result = await buildIndexSmart(true);
          logger.info(`[boot] 강제 전체 재빌드 완료: ${JSON.stringify(result)}`);
          await pool.query(
            `INSERT INTO app_settings (key, value, updated_at) VALUES ('submitcol_fix_20260804_rebuilt', NOW()::text, NOW())
             ON CONFLICT (key) DO NOTHING`);
        } catch (err) {
          logger.error(`[boot] 제출열 오탐지 핫픽스 강제 재빌드 실패(무시, 다음 재배포에 재시도): ${err.message}`);
        }
      })();
    }

    // ★ 블로그체험단 M3 — (주)바를참스킨 0804 작업 1회 동기화 (전용 화면·엔드포인트 없음, 사용자 확정).
    //   이미 무시트 이관된 탭이라 시스템이 시트를 더 안 읽고 내부 시트 사본도 작업표 기준으로
    //   재생성돼 빈 행 기록이 없다 → 시트를 **한 번만** 다시 읽어 1~50 자리를 표에 만든다.
    //   추가만·시트 쓰기 0·멱등. 실패하면 가드를 안 남겨 다음 부팅에 재시도한다(부팅은 계속).
    if (process.env.NODE_ENV === 'production' && !readOnlyPreview) {
      (async () => {
        try {
          const { runBlog0804Backfill } = require('./src/services/blog0804Backfill.service');
          const r = await runBlog0804Backfill();
          if (r && r.reason === 'already_done') return;              // 조용히(평상시 로그 소음 0)
          if (r && r.ok) logger.info(`[boot] 블로그 0804 1회 동기화: ${JSON.stringify(r)}`);
          else logger.warn(`[boot] 블로그 0804 1회 동기화 미수행(다음 부팅에 재시도): ${JSON.stringify(r)}`);
        } catch (err) {
          logger.error(`[boot] 블로그 0804 1회 동기화 실패(무시, 다음 부팅에 재시도): ${err.message}`);
        }
      })();
    }
  });

  // ── Graceful Shutdown (Railway / Docker 대응) ──
  function gracefulShutdown(signal) {
    logger.info(`${signal} 수신 — 서버 종료 시작...`);
    // 스마트 빌드 스케줄러 정지
    const { stopSmartBuild } = require('./src/services/smartBuild.service');
    stopSmartBuild();

    // ★ 빌드 잠금 해제 (재배포 시 좀비 잠금 방지)
    const { releaseBuildLock } = require('./src/services/indexBuilder.service');
    releaseBuildLock()
      .then(() => logger.info('✅ 빌드 잠금 해제 완료'))
      .catch(err => logger.warn(`⚠️ 빌드 잠금 해제 실패 (무시): ${err.message}`));

    server.close(() => {
      logger.info('✅ HTTP 서버 종료 완료');
      const pool = require('./src/db/pool');
      pool.end().then(() => {
        logger.info('✅ DB 풀 종료 완료');
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
    });
    // 10초 후 강제 종료
    setTimeout(() => {
      logger.warn('⚠️ 강제 종료 (타임아웃)');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
})();

// 예상치 못한 에러 로깅
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

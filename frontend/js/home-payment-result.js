/* Home result-file transport and read-only projection. Bank decisions stay server-side. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HomePaymentResult = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function validBatchId(id) {
    return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }
  function canAttach(item, role) {
    return (role === 'admin' || role === 'master') && !!item && item.kind === 'bank_cluster'
      && item.status === 'open' && validBatchId(item.facts && item.facts.batch && item.facts.batch.id)
      && Array.isArray(item.lines) && item.lines.some(x => x && x.key === 'need_file');
  }
  async function postFile(file, options) {
    const o = options;
    if (o.homeBatchId !== undefined && !validBatchId(o.homeBatchId)) throw new Error('대량이체 번호를 확인해 주세요.');
    if (!file || file.size > 12 * 1024 * 1024) throw new Error('파일이 너무 큽니다(12MB 초과).');
    if (o.stillCurrent && !o.stillCurrent()) return null;
    const base64 = await o.readFile(file);
    if (o.stillCurrent && !o.stillCurrent()) return null;
    const url = o.homeBatchId === undefined ? '/api/trackb/payment/result-auto-apply'
      : '/api/trackb/payment/batch/' + encodeURIComponent(o.homeBatchId) + '/home-result-auto-apply';
    return o.request(url, { method: 'POST', body: JSON.stringify({ fileName: file.name, base64: base64 }) });
  }
  const text = v => typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
  const list = v => Array.isArray(v) ? v : [];
  const tail = v => text(v).slice(-4);
  const esc = v => text(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function countText(v) { return count(v) === null ? '확인 불가' : String(v); }
  function warning(v) { return typeof v === 'string' ? v : text(v && (v.message || v.code)); }
  function project(response, target, fileName) {
    const r = response || {}, t = target || {}, s = r.summary || {}, b = r.board || {}, a = r.autoApply || {};
    const row = x => ({ outcome: text(x.outcome), tabName: text(x.tabName), reviewerName: text(x.reviewerName),
      amount: count(x.amount), accountTail: tail(x.accountTail || x.accountNumber), holder: text(x.holder),
      transferredAt: text(x.transferredAt), resultStatus: text(x.resultStatus || x.status), memo: text(x.memo) });
    return {
      batchId: text(t.id), batchSeq: count(t.seq), bankLabel: text(t.bankLabel), fileName: text(fileName), fileRows: count(r.fileRows),
      autoApplied: r.autoApplied === true, held: r.autoApplied === false || list(a.blockers).length > 0, alreadyDone: r.alreadyDone === true,
      applied: count(r.applied), failed: count(r.failed === undefined ? s.failed : r.failed), notInFile: count(r.notInFile === undefined ? s.notInFile : r.notInFile), alreadyPaid: count(s.alreadyPaid),
      boardNotWritten: count(r.applied) !== null && count(b.recorded) !== null ? Math.max(0, r.applied - b.recorded) : null,
      board: { recorded: count(b.recorded), queued: count(b.queued), skipped: count(b.skipped), failed: count(b.failed) },
      notified: count(r.notified), notifyTargets: count(r.notifyTargets), opsWarning: warning(r.opsWarning),
      blockers: list(a.blockers).map(warning), warnings: list(r.warnings).map(warning).concat(list(a.warnings).map(warning)),
      orderAssigned: list(r.orderAssigned).map(x => ({ reviewerName: text(x.reviewerName), amount: count(x.amount), count: count(x.count) })),
      unmatchedResultCount: count(r.unmatchedResultCount) === null ? (Array.isArray(r.unmatchedResults) ? r.unmatchedResults.length : null) : count(r.unmatchedResultCount),
      items: list(r.items).map(row), unmatchedResults: list(r.unmatchedResults).map(row)
    };
  }
  function render(m) {
    const labels = { paid: '입금완료 분석', success: '성공 분석', failed: '실패 분석', not_in_file: '파일에 없음', already_paid: '이미 입금' };
    const blockerLabels = { match_below_90: '대량이체 항목 일치율이 기준 미만입니다', result_outside_batch: '기록 없는 이체 결과가 포함되어 있습니다', duplicate_file: '이미 반영된 동일 결과 파일입니다', no_pending_items: '반영할 미처리 항목이 없습니다', no_matched_results: '매칭된 이체결과가 없습니다' };
    const note = v => '<div class="pmnote">' + v + '</div>';
    const stat = (label, n, cls) => '<div class="pmrs ' + cls + '"><div class="k">' + label + '</div><div class="v">' + countText(n) + '건</div></div>';
    const rows = (xs, outside) => xs.map(x => '<tr><td>' + esc(outside ? '미확인 이체' : (labels[x.outcome] || x.outcome)) + '</td><td>' + esc(outside ? x.memo : x.tabName) + '</td><td>' + esc(x.reviewerName) + '</td><td class="num">' + countText(x.amount) + '</td><td class="mono">…' + esc(x.accountTail) + '</td><td>' + esc(x.holder) + '</td><td>' + esc(x.transferredAt) + '</td><td>' + esc(x.resultStatus) + '</td></tr>').join('');
    return '<div class="pmrbox"><div class="pmrhd"><h3>이체결과 확인 · #' + countText(m.batchSeq) + ' ' + esc(m.bankLabel) + '</h3><span class="sp" style="flex:1"></span><span class="pmauto">' + esc(m.fileName) + ' · 파일 ' + countText(m.fileRows) + '줄</span></div><div class="pmrbd">'
      + note('<b>' + (m.autoApplied ? '자동 반영 완료' : m.held ? '자동 반영 보류' : m.alreadyDone ? '이미 처리된 대량이체' : '자동 반영 보류') + '</b>')
      + '<div class="pmrsum">' + stat('입금완료로 기록', m.applied, 'ok') + stat('실패 분석 건수', m.failed, 'bad') + stat('파일에 없음 분석 건수', m.notInFile, 'wait') + stat('이미 입금 분석 건수', m.alreadyPaid, '') + '</div>'
      + note('분석 건수는 이번에 새로 바뀐 상태 수가 아닙니다. 파일에 없는 사람의 처리는 서버 판정이 기준입니다. 이 창은 읽기 전용입니다.')
      + m.blockers.map(x => note('⚠ ' + esc(blockerLabels[x] || x))).join('')
      + m.warnings.map(x => note('⚠ ' + esc(x))).join('')
      + (m.opsWarning ? note('⚠ 확인할 것 갱신 안내: ' + esc(m.opsWarning)) : '')
      + m.orderAssigned.map(x => note('⚠ 같은 계좌·같은 금액 결과를 순서대로 배정했습니다. 어느 줄에 붙었는지는 임의입니다: ' + esc(x.reviewerName) + ' ' + countText(x.amount) + '원 ' + countText(x.count) + '건')).join('')
      + note('작업보드 입금일 기록 ' + countText(m.board.recorded) + '건 · 기록 대기 ' + countText(m.board.queued) + '건 · 건너뜀 ' + countText(m.board.skipped) + '건 · 기록 실패 ' + countText(m.board.failed) + '건. 입금 기록과 입금일 칸 기록은 별도 결과입니다.')
      + note('입금일 미기록 ' + countText(m.boardNotWritten) + '건 — 이번 입금 기록 수에서 확인된 입금일 기록 수를 뺀 값입니다. 기록 대기·건너뜀·실패를 위에서 확인해 주세요.')
      + note('계좌 확인 안내 전송 ' + countText(m.notified) + '건 / 안내 대상 ' + countText(m.notifyTargets) + '건')
      + note('미확인 이체 ' + countText(m.unmatchedResultCount) + '건 — 이 창에서는 분류·추가 반영하지 않습니다.')
      + '<div class="lgwrap"><table class="lgtable pmtable"><thead><tr><th>분석 결과</th><th>작업·통장표시</th><th>리뷰어</th><th>금액</th><th>계좌 끝 네 자리</th><th>예금주</th><th>이체시각</th><th>은행 응답</th></tr></thead><tbody>' + rows(m.items, false) + rows(m.unmatchedResults, true) + '</tbody></table></div></div><div class="pmrft"><span class="sp" style="flex:1"></span><button class="btn" onclick="_tckHomeResultClose()">닫기</button></div></div>';
  }
  function createController(options) {
    const o = options, sessions = new WeakMap();
    let generation = 0, flight = null, lock = null;
    function capture() {
      const s = Object.freeze({ generation: generation });
      sessions.set(s, { generation: generation, identity: o.identity() });
      return s;
    }
    function current(s) {
      const v = s && sessions.get(s);
      return !!v && v.generation === generation && v.identity === o.identity() && o.allowed() === true;
    }
    function reset() { generation++; flight = null; lock = null; }
    // A promise represents the complete drain, including writes queued during a followup.
    function load(afterWrite) {
      if (flight && current(flight.session)) {
        if (afterWrite === true) flight.followup = true;
        return flight.promise;
      }
      const session = capture();
      if (!current(session)) return Promise.resolve(null);
      const f = { session: session, followup: false, promise: null };
      flight = f;
      f.promise = Promise.resolve().then(async function () {
        let result, error;
        do {
          if (!current(session)) return null;
          try { result = await o.load(session); error = null; }
          catch (e) { error = e; }
          if (!current(session)) return null;
          if (!f.followup) break;
          f.followup = false; // Clear BEFORE the next query so a later write can reserve again.
        } while (true);
        if (error) throw error;
        return result;
      }).finally(function () { if (flight === f) flight = null; });
      return f.promise;
    }
    function paintBusy() { try { if (o.onBusy) o.onBusy(); } catch (_) { /* UI failure must not release another upload. */ } }
    function isBusy(batchId) { return !!lock && current(lock.session) && lock.batchId === batchId; }
    async function upload(file, target, session) {
      const s = session === undefined ? capture() : session;
      const active = () => current(s) && o.isHome() === true;
      if (!active() || (lock && current(lock.session))) return null;
      // Copy primitives, not a question-list index or a mutable parent object.
      const t = Object.freeze({ id: target && target.id, seq: target && target.seq, bankLabel: target && target.bankLabel });
      const owner = { session: s, batchId: t.id };
      lock = owner;
      paintBusy();
      let submitted = false, response;
      try {
        try {
          response = await postFile(file, {
            homeBatchId: t.id === undefined ? null : t.id,
            readFile: o.readFile,
            request: function (url, init) {
              if (!active()) return null;
              submitted = true;
              return o.request(url, init);
            },
            stillCurrent: active
          });
        } catch (_) {
          if (active()) o.notice(submitted
            ? '반영 여부 확인 불가 — 응답을 받지 못했습니다. 자동 재전송하지 않습니다. 입금관리에서 확인해 주세요.'
            : '파일 또는 대량이체 번호를 확인해 주세요. 파일을 읽어 전송하지 못했습니다.');
          return null;
        }
        if (!current(s)) return null;
        if (!submitted) return null;
        if (!response || response.ok !== true) {
          if (active()) o.notice(response && response.code === 'wrong_batch'
            ? '이 파일은 선택한 대량이체의 결과가 아닙니다. 파일을 다시 확인해 주세요.'
            : '반영 여부 확인 불가 — 서버 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다. 입금관리에서 확인해 주세요.');
          return null;
        }
        const model = project(response, t, file.name);
        response = null; // Never retain the raw response in controller state or results.
        if (active()) o.show(model);
        if (!current(s)) return null;
        let refreshFailed = false;
        try { const refreshed = await load(true); refreshFailed = !!refreshed && refreshed.ok === false; }
        catch (_) { refreshFailed = true; }
        if (refreshFailed && active()) o.notice('이체결과는 위에 표시했습니다. 질문 목록을 새로 불러오지 못했습니다. 새로고침해 주세요.');
        if (!current(s)) return null;
        return { model: model };
      } finally {
        if (lock === owner) {
          lock = null;
          if (current(s)) paintBusy();
        }
      }
    }
    return { capture: capture, current: current, reset: reset, load: load, upload: upload, isBusy: isBusy };
  }
  return { createController: createController, validBatchId: validBatchId, canAttach: canAttach, postFile: postFile, project: project, countText: countText, render: render };
});

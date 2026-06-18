          return `
            <div class="rc-card" data-ch="${escHtml(channel)}">
              <div class="rc-row">
                <div class="rc-thumb">
                  <span class="rc-thumb-emoji">${channel.indexOf("네이버")>=0?"📗":channel.indexOf("쿠팡")>=0?"📦":channel.indexOf("마켓")>=0?"🛒":channel.indexOf("스토어")>=0?"🟢":channel.indexOf("11")>=0?"🛍️":"📢"}</span>
                  ${channel ? `<span class="rc-thumb-ch">${escHtml(channel)}</span>` : ""}
                </div>
                <div class="rc-body">
                  <div class="rc-card-top">
                    ${channel ? `<span class="rc-channel">${escHtml(channel)}</span>` : ""}
                    <span class="rc-status${isFull?" rc-status-full":""}">${isFull?"모집마감":"모집중"}</span>
                    ${c.manager ? `<span class="rc-manager">${managerEmoji} ${escHtml(c.manager)}</span>` : ""}
                  </div>
                  <div class="rc-title">${escHtml(c.title)}</div>
                  ${badges.length ? `<div class="rc-badges">${badges.map(b=>`<span class="rc-badge">${escHtml(b)}</span>`).join("")}</div>` : ""}
                  <div class="rc-meta">
                    ${fee ? `<span class="rc-fee"><i class="fas fa-won-sign"></i> 리뷰비 ${fee}</span>` : ""}
                    ${c.delivery_type ? `<span><i class="fas fa-truck"></i> ${escHtml(c.delivery_type)}</span>` : ""}
                    ${c.time_range ? `<span><i class="fas fa-clock"></i> ${escHtml(c.time_range)}</span>` : ""}
                    ${slots}
                  </div>
                </div>
              </div>
              ${c.notes ? `<div class="rc-notes">${escHtml(c.notes)}</div>` : ""}
              ${actionBtn}
              <div class="rc-inline-form" id="rcForm_${c.id}" style="display:none">
                <div class="rc-form-fields">
                  <input type="text" class="rc-input" id="rcName_${c.id}" placeholder="이름">
                  <input type="tel" class="rc-input" id="rcPhone_${c.id}" placeholder="연락처 (010-XXXX-XXXX)">
                </div>
                <div class="rc-form-actions">
                  <button class="rc-submit-btn" onclick="submitInlineApply('${c.id}')"><i class="fas fa-check"></i> 신청 완료</button>
                  <button class="rc-cancel-btn" onclick="closeInlineApply('${c.id}')">취소</button>
                </div>
              </div>
            </div>`;
        }).join("");

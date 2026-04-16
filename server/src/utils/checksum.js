const crypto = require('crypto');

/**
 * MD5 체크섬 계산 (GAS의 체크섬 비교 로직 대체)
 * @param {*} data - JSON.stringify 가능한 데이터
 * @returns {string} MD5 해시 (hex)
 */
function computeChecksum(data) {
  return crypto
    .createHash('md5')
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('hex');
}

module.exports = { computeChecksum };

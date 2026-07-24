// Thin wrapper around the already-live student endpoints. Only the four public
// endpoints exist here; the review console stays on the operator's machine.

const STATUS_LABELS = {
  queued: "排队中",
  under_review: "老师复核中",
  feedback_released: "已反馈",
  unsupported: "暂不支持"
};

const PILL_CLASS = {
  queued: "queued",
  under_review: "rev",
  feedback_released: "done",
  unsupported: "unsupported"
};

function base() {
  return getApp().globalData.apiBase;
}

function studentRef() {
  return getApp().globalData.studentRef;
}

function get(pathname, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: base() + pathname,
      data: data || {},
      method: "GET",
      success: (res) => (res.statusCode === 200 ? resolve(res.data) : reject(res)),
      fail: reject
    });
  });
}

function getWechatLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res && res.code ? resolve(res.code) : reject(new Error("WeChat login code is unavailable."))),
      fail: reject
    });
  });
}

function uploadAudio(filePath, formData) {
  return getWechatLoginCode().then((loginCode) => new Promise((resolve, reject) => {
    const nextFormData = Object.assign({}, formData || {});
    let payload = {};
    try {
      payload = JSON.parse(nextFormData.payload || "{}");
    } catch (err) {
      return reject(err);
    }
    // The server exchanges this one-time code for an OpenID and calls WeChat's
    // content-security APIs. Neither the AppSecret nor an access token enters
    // the Mini Program.
    payload.clientPlatform = "wechat-mini-program";
    payload.wechatLoginCode = loginCode;
    nextFormData.payload = JSON.stringify(payload);
    wx.uploadFile({
      url: base() + "/api/strings/analyze",
      filePath,
      name: "audio",
      formData: nextFormData,
      success: (res) => {
        let responseData = null;
        try {
          responseData = JSON.parse(res.data);
        } catch (err) {
          return reject(err);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject({ statusCode: res.statusCode, data: responseData });
        }
        resolve(responseData);
      },
      fail: reject
    });
  }));
}

// Student-side projection helpers: turn a raw submission into what the UI shows.
function decorate(submission) {
  const status = submission.status || "queued";
  return Object.assign({}, submission, {
    statusText: STATUS_LABELS[status] || status,
    pillClass: PILL_CLASS[status] || "queued",
    isDone: status === "feedback_released",
    submittedAtText: (submission.submittedAt || "").slice(0, 16).replace("T", " ")
  });
}

function decorateList(list) {
  return (list || []).map(decorate);
}

module.exports = { get, uploadAudio, studentRef, decorate, decorateList, STATUS_LABELS };

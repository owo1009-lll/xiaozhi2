const api = require("../../utils/api.js");
const INSTRUMENT_LABELS = { violin: "小提琴", viola: "中提琴", cello: "大提琴" };

Page({
  data: { item: null, canViewScore: false },

  onLoad() {
    const item = wx.getStorageSync("currentFeedback") || null;
    if (item) {
      item.instrumentText = INSTRUMENT_LABELS[item.instrument] || item.instrument || "";
    }
    this.setData({ item, canViewScore: Boolean(item && item.isDone && item.pieceId) });
    if (item && item.isDone && !item.pieceId) {
      api.get("/api/strings/score-editions")
        .then((result) => {
          const matched = (result.editions || []).find((edition) => edition.title === item.piece);
          if (!matched) return;
          item.pieceId = matched.pieceId;
          this.setData({ item, canViewScore: true });
        })
        .catch(() => {});
    }
  },

  openProblemScore() {
    if (!this.data.item || !this.data.item.pieceId) return;
    wx.navigateTo({
      url: "/pages/review-score/review-score?pieceId="
        + encodeURIComponent(this.data.item.pieceId)
        + "&submissionId="
        + encodeURIComponent(this.data.item.submissionId || "")
        + (this.data.item.isDemo ? "&demo=1" : "")
    });
  }
});

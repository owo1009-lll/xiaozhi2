const api = require("../../utils/api.js");

Page({
  data: {
    list: [],
    loading: true,
    stats: { total: 0, done: 0, review: 0 }
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    api.get("/api/strings/student-submissions", { studentRef: api.studentRef(), limit: 50 })
      .then((r) => {
        const realList = api.decorateList(r.submissions);
        const demo = api.decorate({
          submissionId: "demo-injected-r2-01",
          submittedAt: "",
          piece: "诊断功能测试 · 三类问题",
          pieceId: "r2-01",
          instrument: "violin",
          status: "feedback_released",
          teacherFeedback: "该测试录音包含音准不符、漏音和节奏拖拍；打开问题谱面可查看三种独立颜色。",
          isDemo: true
        });
        demo.submittedAtText = "合成测试 · 音准 / 漏音 / 节奏";
        const list = [demo].concat(realList);
        const stats = {
          total: realList.length,
          done: realList.filter((s) => s.status === "feedback_released").length,
          review: realList.filter((s) => s.status === "under_review" || s.status === "queued").length
        };
        this.setData({ list, stats, loading: false });
      })
      .catch(() => this.setData({ loading: false }));
  },

  openItem(e) {
    wx.setStorageSync("currentFeedback", e.currentTarget.dataset.item);
    wx.navigateTo({ url: "/pages/feedback/feedback" });
  }
});

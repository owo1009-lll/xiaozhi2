const api = require("../../utils/api.js");

function toBox(bn) {
  return {
    left: (bn[0] * 100).toFixed(2),
    top: (bn[1] * 100).toFixed(2),
    w: ((bn[2] - bn[0]) * 100).toFixed(2),
    h: ((bn[3] - bn[1]) * 100).toFixed(2)
  };
}

function categoryForLabel(label) {
  const text = String(label || "");
  if (/节奏|时值|拍点|拍子|rhythm|timing|onset/i.test(text)) return "rhythm";
  if (/音质|音色|杂音|噪音|tone|timbre|noise/i.test(text)) return "tone";
  if (/漏音|未听到|缺失|错音|missing|wrong/i.test(text)) return "missing";
  return "pitch";
}

Page({
  data: {
    editions: [],
    relatedEditions: [],
    currentId: "",
    currentScoreId: "",
    currentEditionId: "",
    currentTitle: "",
    currentMeta: "",
    pageUrls: [],
    imageError: "",
    loading: true,
    showAll: false,
    allBoxes: [],
    errBoxes: [],
    noteBoxes: [],
    diagSummary: "",
    hasDiag: false
  },

  onLoad(query) {
    this.initialPieceId = decodeURIComponent((query && query.pieceId) || "");
    this.load();
  },

  load() {
    this.setData({ loading: true });
    api.get("/api/strings/score-editions")
      .then((r) => {
        const editions = r.editions || [];
        this.setData({ editions, loading: false });
        if (editions.length) {
          const selected = editions.find((item) => item.pieceId === this.initialPieceId) || editions[0];
          this.showEdition(selected);
        }
      })
      .catch(() => this.setData({ loading: false, imageError: "谱面目录加载失败，请检查网络后重试。" }));
  },

  select(e) {
    const edition = this.data.editions.find((item) => item.pieceId === e.currentTarget.dataset.id);
    if (edition) this.showEdition(edition);
  },

  showEdition(edition) {
    const base = getApp().globalData.apiBase;
    const pieceId = edition.pieceId;
    const editionId = edition.editionId || "";
    const pageCount = Math.max(1, Number(edition.pageCount) || 1);
    const pageUrls = Array.from({ length: pageCount }, (_, index) =>
      base + "/api/strings/score-render?pieceId=" + encodeURIComponent(pieceId)
        + "&editionId=" + encodeURIComponent(editionId)
        + "&page=" + (index + 1));
    this.setData({
      currentId: pieceId,
      currentScoreId: edition.scoreId || "",
      currentEditionId: editionId,
      currentTitle: edition.title,
      currentMeta: edition.meta || (pageCount + "页"),
      relatedEditions: this.data.editions.filter((item) => item.group === edition.group),
      pageUrls,
      imageError: "",
      allBoxes: [],
      errBoxes: [],
      noteBoxes: [],
      diagSummary: "",
      hasDiag: false
    });

    if (!edition.hasCoordinates) return;

    // 小节网格(验证坐标对齐,可开关)
    api.get("/api/strings/score-coordinates", { pieceId, editionId })
      .then((r) => {
        const measures = (r.coordinates || {}).measures || [];
        this.setData({
          allBoxes: measures.map((m) => Object.assign(toBox(m.bboxNormalized), { k: "m" + m.globalMeasureIndex }))
        });
      })
      .catch(() => {});

    // 真实诊断定位(旧录音跑出的判定 + 坐标合成)
    api.get("/api/strings/score-diagnosis", { pieceId, editionId })
      .then((r) => {
        const errBoxes = (r.measureIssues || []).map((m) =>
          Object.assign(toBox(m.bbox), {
            k: "e" + m.measure,
            label: (m.labels || []).join(" · "),
            category: categoryForLabel((m.labels || []).join(" "))
          }));
        const noteBoxes = (r.noteIssues || []).map((n, i) =>
          Object.assign(toBox(n.bbox), {
            k: "n" + i,
            category: categoryForLabel(n.label)
          }));
        this.setData({
          errBoxes,
          noteBoxes,
          hasDiag: r.hasData === true,
          diagSummary: r.hasData ? this.formatSummary(r) : ""
        });
      })
      .catch(() => {});
  },

  previewPage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.url,
      urls: this.data.pageUrls
    });
  },

  onImageError() {
    this.setData({
      imageError: "谱面图片加载失败。请确认小程序后台的 downloadFile 合法域名已添加 api.stringinstrumentdiagnosis.icu。"
    });
  },

  chooseCurrent() {
    wx.setStorageSync("selectedPiece", this.data.currentTitle);
    wx.setStorageSync("selectedPieceId", this.data.currentId);
    wx.setStorageSync("selectedScoreId", this.data.currentScoreId);
    wx.showToast({ title: "已选：" + this.data.currentTitle, icon: "none" });
    setTimeout(() => wx.switchTab({ url: "/pages/upload/upload" }), 500);
  },

  formatSummary(r) {
    const n = (r.noteIssues || []).length;
    if (n === 0) return "本条录音:未发现明显问题音。";
    return "本条录音:标出 " + n + " 处问题音(音准 / 漏音),已定位到谱面。";
  },

  toggleAll() {
    this.setData({ showAll: !this.data.showAll });
  },

  onShareAppMessage() {
    const pieceId = this.data.currentId || "";
    return {
      title: (this.data.currentTitle || "弦乐谱面") + " · AI 弦乐练习",
      path: "/pages/score/score?pieceId=" + encodeURIComponent(pieceId)
    };
  }
});

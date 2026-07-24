const api = require("../../utils/api.js");

const CHINESE_TITLES = {
  "r2-01": "D大调级进练习曲",
  "r2-06": "D大调长音与揉弦练习曲",
  "r3-01": "E小调练习曲"
};

const BUILTIN_EDITIONS = {
  "r2-01": {
    pieceId: "r2-01",
    editionId: "self-authored-v1",
    pageCount: 1,
    meta: "1页",
    localPageUrls: ["/assets/scores/r2-01.png"]
  },
  "r2-06": {
    pieceId: "r2-06",
    editionId: "self-authored-v1",
    pageCount: 1,
    meta: "1页",
    localPageUrls: ["/assets/scores/r2-06.png"]
  },
  "r3-01": {
    pieceId: "r3-01",
    editionId: "self-authored-v1",
    pageCount: 1,
    meta: "1页",
    localPageUrls: ["/assets/scores/r3-01.png"]
  }
};

function toBox(bbox) {
  return {
    left: (bbox[0] * 100).toFixed(2),
    top: (bbox[1] * 100).toFixed(2),
    width: ((bbox[2] - bbox[0]) * 100).toFixed(2),
    height: ((bbox[3] - bbox[1]) * 100).toFixed(2)
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
    loading: true,
    title: "",
    meta: "",
    pageUrls: [],
    measureIssues: [],
    noteIssues: [],
    issueCount: 0,
    hasDiagnosis: false,
    message: "",
    zoomScale: 1,
    zoomPercent: 100,
    currentPage: 0,
    imageReady: false,
    imageError: "",
    loadedPages: []
  },

  onLoad(query) {
    this.pieceId = decodeURIComponent((query && query.pieceId) || "");
    this.submissionId = decodeURIComponent((query && query.submissionId) || "");
    this.demo = query && query.demo === "1";
    this.currentScale = 1;
    this.load();
  },

  load() {
    const builtin = BUILTIN_EDITIONS[this.pieceId];
    const editionRequest = builtin
      ? Promise.resolve({ editions: [Object.assign({}, builtin, { title: CHINESE_TITLES[this.pieceId] })] })
      : api.get("/api/strings/score-editions", { pieceId: this.pieceId });
    editionRequest
      .then((result) => {
        const edition = (result.editions || []).find((item) => item.pieceId === this.pieceId);
        if (!edition) {
          this.setData({ loading: false, message: "没有找到这条记录对应的谱面。" });
          return;
        }
        const base = getApp().globalData.apiBase;
        const editionId = edition.editionId || "";
        const pageCount = Math.max(1, Number(edition.pageCount) || 1);
        const pageUrls = edition.localPageUrls || Array.from({ length: pageCount }, (_, index) =>
          base + "/api/strings/score-render?pieceId=" + encodeURIComponent(this.pieceId)
            + "&editionId=" + encodeURIComponent(editionId)
            + "&page=" + (index + 1));
        this.setData({
          loading: false,
          title: CHINESE_TITLES[edition.pieceId] || edition.title || "问题谱面",
          meta: edition.meta || (pageCount + "页"),
          pageUrls,
          imageReady: false,
          imageError: "",
          loadedPages: []
        });
        return api.get("/api/strings/score-diagnosis", {
          pieceId: this.pieceId,
          editionId,
          demo: this.demo ? "1" : ""
        });
      })
      .then((diagnosis) => {
        if (!diagnosis) return;
        const measureIssues = (diagnosis.measureIssues || []).map((issue) =>
          Object.assign(toBox(issue.bbox), {
            key: "m" + issue.measure,
            label: (issue.labels || []).join(" · "),
            category: categoryForLabel((issue.labels || []).join(" "))
          }));
        const noteIssues = (diagnosis.noteIssues || []).map((issue, index) =>
          Object.assign(toBox(issue.bbox), {
            key: "n" + index,
            label: issue.label || "问题音",
            category: categoryForLabel(issue.label)
          }));
        const issueCount = noteIssues.length;
        this.setData({
          measureIssues,
          noteIssues,
          issueCount,
          hasDiagnosis: diagnosis.hasData === true,
          message: diagnosis.hasData === true
            ? (diagnosis.isDemo
              ? "合成测试：音准、漏音和节奏问题均已标出"
              : (issueCount ? "不同颜色标出了本次复核的问题位置" : "本次复核未发现明显问题音"))
            : "这条记录暂时没有可显示的问题定位。"
        });
      })
      .catch(() => {
        this.setData({ loading: false, message: "问题谱面加载失败，请稍后重试。" });
      });
  },

  onPageChange(e) {
    const currentPage = Number(e.detail.current) || 0;
    this.currentScale = 1;
    this.setData({
      currentPage,
      zoomScale: 1,
      zoomPercent: 100,
      imageReady: Boolean(this.data.loadedPages[currentPage]),
      imageError: ""
    });
  },

  onImageLoad(e) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const loadedPages = this.data.loadedPages.slice();
    loadedPages[index] = true;
    this.setData({
      loadedPages,
      imageReady: index === this.data.currentPage ? true : this.data.imageReady,
      imageError: index === this.data.currentPage ? "" : this.data.imageError
    });
  },

  onImageError() {
    this.setData({
      imageReady: false,
      imageError: "谱面图片加载失败，请检查网络后重试。"
    });
  },

  onScale(e) {
    const scale = Math.max(1, Math.min(4, Number(e.detail.scale) || 1));
    const zoomPercent = Math.round(scale * 100);
    this.currentScale = scale;
    if (zoomPercent !== this.data.zoomPercent || Math.abs(scale - this.data.zoomScale) > 0.01) {
      this.setData({ zoomScale: scale, zoomPercent });
    }
  },

  zoomIn() {
    this.setZoom(this.currentScale + 0.5);
  },

  zoomOut() {
    this.setZoom(this.currentScale - 0.5);
  },

  resetZoom() {
    this.setZoom(1);
  },

  setZoom(scale) {
    const next = Math.max(1, Math.min(4, Math.round(scale * 2) / 2));
    this.currentScale = next;
    this.setData({
      zoomScale: next,
      zoomPercent: Math.round(next * 100)
    });
  },

  goBack() {
    wx.navigateBack();
  }
});

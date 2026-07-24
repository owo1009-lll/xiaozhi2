const api = require("../../utils/api.js");

Page({
  data: {
    groups: [],
    repertoireGroups: [],
    exerciseGroups: [],
    loading: true,
    error: "",
    pieceCount: 0,
    repertoireCount: 0,
    exerciseCount: 0,
    activeCategory: "repertoire",
    collapseActionText: "全部展开"
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: "" });
    api.get("/api/strings/score-editions")
      .then((result) => {
        const publicEditions = (result.editions || [])
          .filter((edition) => edition.scoreId && edition.group !== "诊断练习曲");
        const repertoire = publicEditions.filter((edition) => edition.libraryCategory !== "exercise");
        const exercises = publicEditions.filter((edition) => edition.libraryCategory === "exercise");
        const groupEditions = (editions) => {
          const byGroup = new Map();
          editions.forEach((edition) => {
          const groupName = edition.group || "诊断练习曲";
          if (!byGroup.has(groupName)) {
            byGroup.set(groupName, { level: groupName, items: [] });
          }
          byGroup.get(groupName).items.push(edition);
          });
          return Array.from(byGroup.values()).map((group, index) =>
            Object.assign(group, { collapsed: index !== 0 }));
        };
        const repertoireGroups = groupEditions(repertoire);
        const exerciseGroups = groupEditions(exercises);
        this.setData({
          groups: repertoireGroups,
          repertoireGroups,
          exerciseGroups,
          loading: false,
          pieceCount: publicEditions.length,
          repertoireCount: repertoire.length,
          exerciseCount: exercises.length,
          collapseActionText: repertoireGroups.some((group) => group.collapsed)
            ? "全部展开"
            : "全部收起"
        });
      })
      .catch(() => {
        this.setData({
          loading: false,
          error: "曲库加载失败，请检查网络后重试。"
        });
      });
  },

  selectCategory(e) {
    const category = e.currentTarget.dataset.category;
    const groups = category === "exercise" ? this.data.exerciseGroups : this.data.repertoireGroups;
    this.setData({
      activeCategory: category,
      groups,
      collapseActionText: groups.some((group) => group.collapsed) ? "全部展开" : "全部收起"
    });
  },

  toggleGroup(e) {
    const level = e.currentTarget.dataset.level;
    const sourceKey = this.data.activeCategory === "exercise"
      ? "exerciseGroups"
      : "repertoireGroups";
    const groups = this.data[sourceKey].map((group) =>
      group.level === level
        ? Object.assign({}, group, { collapsed: !group.collapsed })
        : group);
    this.setData({
      [sourceKey]: groups,
      groups,
      collapseActionText: groups.some((group) => group.collapsed) ? "全部展开" : "全部收起"
    });
  },

  toggleAllGroups() {
    const sourceKey = this.data.activeCategory === "exercise"
      ? "exerciseGroups"
      : "repertoireGroups";
    const shouldExpand = this.data[sourceKey].some((group) => group.collapsed);
    const groups = this.data[sourceKey].map((group) =>
      Object.assign({}, group, { collapsed: !shouldExpand }));
    this.setData({
      [sourceKey]: groups,
      groups,
      collapseActionText: shouldExpand ? "全部收起" : "全部展开"
    });
  },

  openScore(e) {
    const pieceId = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: "/pages/score/score?pieceId=" + encodeURIComponent(pieceId)
    });
  },

  onShareAppMessage() {
    return {
      title: "AI 弦乐练习 · 曲目与谱面",
      path: "/pages/library/library"
    };
  }
});

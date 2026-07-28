App({
  globalData: {
    // 已上线的后端(api 子域,经 Cloudflare 隧道到本机分析器)。
    apiBase: "https://api.stringinstrumentdiagnosis.icu",
    studentRef: ""
  },
  onLaunch() {
    // 仅用于本机资料页的匿名尾号；服务端授权使用 wx.login 换取的 OpenID 绑定。
    let ref = wx.getStorageSync("studentRef");
    if (!ref) {
      ref = "stu-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync("studentRef", ref);
    }
    this.globalData.studentRef = ref;
  }
});

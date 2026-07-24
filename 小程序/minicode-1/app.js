App({
  globalData: {
    // 已上线的后端(api 子域,经 Cloudflare 隧道到本机分析器)。
    apiBase: "https://api.stringinstrumentdiagnosis.icu",
    studentRef: ""
  },
  onLaunch() {
    // 匿名学生标识,存在本地,和网页版同一套思路:一台设备一个 ref。
    let ref = wx.getStorageSync("studentRef");
    if (!ref) {
      ref = "stu-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      wx.setStorageSync("studentRef", ref);
    }
    this.globalData.studentRef = ref;
  }
});

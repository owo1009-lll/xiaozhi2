const api = require("../../utils/api.js");

const PROFILE_KEY = "studentProfileV1";
const DEFAULT_PROFILE = {
  nickname: "琴童",
  bio: "记录每一次认真练习"
};

function computeStreak(daySet) {
  const days = Array.from(daySet).sort().reverse();
  if (!days.length) return 0;
  let streak = 1;
  let prev = new Date(days[0]);
  for (let i = 1; i < days.length; i++) {
    const cur = new Date(days[i]);
    const diff = Math.round((prev - cur) / 86400000);
    if (diff === 1) {
      streak++;
      prev = cur;
    } else if (diff === 0) {
      continue;
    } else {
      break;
    }
  }
  return streak;
}

Page({
  data: {
    refTail: "",
    total: 0,
    feedbackCount: 0,
    streak: 0,
    badges: [],
    nickname: DEFAULT_PROFILE.nickname,
    bio: DEFAULT_PROFILE.bio,
    editing: false,
    draftNickname: DEFAULT_PROFILE.nickname,
    draftBio: DEFAULT_PROFILE.bio
  },

  onShow() {
    const ref = api.studentRef();
    const saved = wx.getStorageSync(PROFILE_KEY) || {};
    const nickname = String(saved.nickname || DEFAULT_PROFILE.nickname);
    const bio = String(saved.bio || DEFAULT_PROFILE.bio);
    this.setData({
      refTail: ref ? ref.slice(-4).toUpperCase() : "----",
      nickname,
      bio,
      draftNickname: nickname,
      draftBio: bio
    });
    this.load();
  },

  startEdit() {
    this.setData({
      editing: true,
      draftNickname: this.data.nickname,
      draftBio: this.data.bio
    });
  },

  onNicknameInput(e) {
    this.setData({ draftNickname: e.detail.value });
  },

  onBioInput(e) {
    this.setData({ draftBio: e.detail.value });
  },

  cancelEdit() {
    this.setData({
      editing: false,
      draftNickname: this.data.nickname,
      draftBio: this.data.bio
    });
  },

  saveProfile() {
    const nickname = String(this.data.draftNickname || "").trim();
    const bio = String(this.data.draftBio || "").trim();
    if (!nickname) {
      wx.showToast({ title: "请输入昵称", icon: "none" });
      return;
    }
    const profile = {
      nickname: nickname.slice(0, 12),
      bio: (bio || DEFAULT_PROFILE.bio).slice(0, 40)
    };
    wx.setStorageSync(PROFILE_KEY, profile);
    this.setData(Object.assign({ editing: false }, profile));
    wx.showToast({ title: "资料已保存", icon: "success" });
  },

  load() {
    api.get("/api/strings/student-submissions", { studentRef: api.studentRef(), limit: 100 })
      .then((r) => {
        const list = r.submissions || [];
        const total = list.length;
        const feedbackCount = list.filter((s) => s.status === "feedback_released").length;
        const daySet = new Set(list.map((s) => (s.submittedAt || "").slice(0, 10)).filter(Boolean));
        const streak = computeStreak(daySet);
        const badges = [
          { icon: "♪", name: "初次登台", desc: "完成第一次练习", got: total >= 1 },
          { icon: "♫", name: "勤学十遍", desc: "累计练习 10 次", got: total >= 10 },
          { icon: "★", name: "三日不辍", desc: "连续练习 3 天", got: streak >= 3 },
          { icon: "✦", name: "一周精进", desc: "连续练习 7 天", got: streak >= 7 }
        ];
        this.setData({ total, feedbackCount, streak, badges });
      })
      .catch(() => {});
  }
});

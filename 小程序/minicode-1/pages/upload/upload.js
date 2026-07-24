const api = require("../../utils/api.js");
const recorder = wx.getRecorderManager();
const CONTENT_SAFETY_TICKETS_KEY = "pendingContentSafetyTickets";
const AUDIO_FILE_MIME_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac"
};
const MAX_AUDIO_FILE_BYTES = 40 * 1024 * 1024;

Page({
  data: {
    piece: "",
    selectedPieceId: "",
    selectedScoreId: "",
    instrument: "violin",
    instruments: ["小提琴", "中提琴", "大提琴"],
    instrumentIds: ["violin", "viola", "cello"],
    instrumentIndex: 0,
    recording: false,
    recordStarting: false,
    recordedPath: "",
    recordedName: "",
    recordedMimeType: "",
    audioSource: "",
    photoPath: "",
    recordSeconds: 0,
    recordError: "",
    submitting: false,
    notice: "",
    recent: []
  },

  onLoad() {
    recorder.onStart(() => {
      if (this._recordStartWatchdog) {
        clearTimeout(this._recordStartWatchdog);
        this._recordStartWatchdog = null;
      }
      if (this._timer) clearInterval(this._timer);
      this.setData({
        recording: true,
        recordStarting: false,
        recordedPath: "",
        recordedName: "",
        recordedMimeType: "",
        audioSource: "recording",
        recordSeconds: 0,
        recordError: ""
      });
      this._timer = setInterval(() => {
        this.setData({ recordSeconds: this.data.recordSeconds + 1 });
      }, 1000);
    });
    recorder.onStop((res) => {
      if (this._recordStartWatchdog) {
        clearTimeout(this._recordStartWatchdog);
        this._recordStartWatchdog = null;
      }
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (!res || !res.tempFilePath) {
        this.failRecording("录音没有生成文件，请重新录制");
        return;
      }
      this.setData({
        recording: false,
        recordStarting: false,
        recordedPath: res.tempFilePath,
        recordedName: "practice.mp3",
        recordedMimeType: "audio/mpeg",
        audioSource: "recording",
        recordError: ""
      });
    });
    recorder.onError((error) => {
      const detail = String((error && error.errMsg) || "");
      this.failRecording(detail ? "录音失败：" + detail : "录音失败，请检查麦克风权限");
    });
  },

  onShow() {
    const selected = wx.getStorageSync("selectedPiece");
    const selectedPieceId = wx.getStorageSync("selectedPieceId");
    const selectedScoreId = wx.getStorageSync("selectedScoreId");
    if (selected) {
      this.setData({
        piece: selected,
        selectedPieceId: selectedPieceId || "",
        selectedScoreId: selectedScoreId || ""
      });
      wx.removeStorageSync("selectedPiece");
      wx.removeStorageSync("selectedPieceId");
      wx.removeStorageSync("selectedScoreId");
    }
    this.loadRecent();
    this.resumeContentSafetyChecks();
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer);
    if (this._recordStartWatchdog) clearTimeout(this._recordStartWatchdog);
    if (this._contentSafetyTimers) {
      Object.keys(this._contentSafetyTimers).forEach((ticket) => clearTimeout(this._contentSafetyTimers[ticket]));
    }
  },

  goLibrary() {
    wx.switchTab({ url: "/pages/library/library" });
  },

  loadRecent() {
    api.get("/api/strings/student-submissions", { studentRef: api.studentRef(), limit: 3 })
      .then((r) => this.setData({ recent: api.decorateList(r.submissions) }))
      .catch(() => {});
  },

  onPiece(e) {
    this.setData({ piece: e.detail.value, selectedPieceId: "", selectedScoreId: "" });
  },

  onInstrument(e) {
    const i = Number(e.detail.value);
    this.setData({ instrumentIndex: i, instrument: this.data.instrumentIds[i] });
  },

  toggleRecord() {
    if (this.data.recording) {
      recorder.stop();
      return;
    }
    if (this.data.recordStarting) return;
    this.setData({ recordStarting: true, recordError: "" });
    this.requestRecordingPrivacy();
  },

  requestRecordingPrivacy() {
    if (typeof wx.getPrivacySetting !== "function" || typeof wx.requirePrivacyAuthorize !== "function") {
      this.requestMicrophonePermission();
      return;
    }
    wx.getPrivacySetting({
      success: (privacy) => {
        if (!privacy.needAuthorization) {
          this.requestMicrophonePermission();
          return;
        }
        wx.requirePrivacyAuthorize({
          success: () => this.requestMicrophonePermission(),
          fail: (error) => {
            const detail = String((error && error.errMsg) || "");
            this.failRecording(detail ? "请先同意隐私保护说明：" + detail : "请先同意隐私保护说明");
          }
        });
      },
      fail: () => this.requestMicrophonePermission()
    });
  },

  requestMicrophonePermission() {
    const requestMicrophone = () => {
      wx.getSetting({
        success: (setting) => {
          if (setting.authSetting["scope.record"] === true) {
            this.startRecorder();
            return;
          }
          if (setting.authSetting["scope.record"] === false) {
            this.setData({ recordStarting: false });
            wx.showModal({
              title: "需要麦克风权限",
              content: "请在设置中允许使用麦克风后再录音。",
              confirmText: "去设置",
              success: (result) => {
                if (!result.confirm) return;
                wx.openSetting({
                  success: (settings) => {
                    if (settings.authSetting["scope.record"] === true) {
                      this.startRecorder();
                    } else {
                      this.failRecording("麦克风权限仍未开启");
                    }
                  },
                  fail: () => this.failRecording("无法打开麦克风设置")
                });
              }
            });
            return;
          }
          wx.authorize({
            scope: "scope.record",
            success: () => this.startRecorder(),
            fail: () => this.failRecording("需要麦克风权限才能录音")
          });
        },
        fail: () => this.failRecording("无法读取麦克风权限")
      });
    };
    requestMicrophone();
  },

  startRecorder() {
    try {
      this.setData({ recordStarting: true, recordError: "" });
      this._recordStartWatchdog = setTimeout(() => {
        if (this.data.recordStarting && !this.data.recording) {
          this.failRecording("录音未能启动，请检查微信和系统的麦克风权限");
        }
      }, 4000);
      recorder.start({ format: "mp3", duration: 600000, sampleRate: 44100, numberOfChannels: 1, encodeBitRate: 128000 });
    } catch (error) {
      const detail = String((error && error.message) || "");
      this.failRecording(detail ? "录音启动失败：" + detail : "录音启动失败，请重试");
    }
  },

  failRecording(message) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._recordStartWatchdog) {
      clearTimeout(this._recordStartWatchdog);
      this._recordStartWatchdog = null;
    }
    this.setData({
      recording: false,
      recordStarting: false,
      recordError: message
    });
    wx.showToast({ title: message, icon: "none", duration: 3000 });
  },

  choosePhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["camera", "album"],
      sizeType: ["compressed"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (file) this.setData({ photoPath: file.tempFilePath });
      }
    });
  },

  removePhoto() {
    this.setData({ photoPath: "" });
  },

  chooseAudioFile() {
    if (this.data.recording || this.data.recordStarting) return;
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: Object.keys(AUDIO_FILE_MIME_TYPES),
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        const filePath = file && (file.path || file.tempFilePath);
        const fileName = String((file && file.name) || "practice.mp3");
        const extension = ((fileName.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || "").toLowerCase();
        if (!filePath || !AUDIO_FILE_MIME_TYPES[extension]) {
          wx.showToast({ title: "请选择 MP3、M4A、WAV 或 AAC 文件", icon: "none" });
          return;
        }
        if (Number(file.size) > MAX_AUDIO_FILE_BYTES) {
          wx.showToast({ title: "录音文件不能超过 40MB", icon: "none" });
          return;
        }
        this.setData({
          recordedPath: filePath,
          recordedName: fileName,
          recordedMimeType: AUDIO_FILE_MIME_TYPES[extension],
          audioSource: "file",
          recordSeconds: 0,
          recordError: ""
        });
      },
      fail: (error) => {
        const detail = String((error && error.errMsg) || "");
        if (!/cancel/i.test(detail)) {
          wx.showToast({ title: "录音文件选择失败", icon: "none" });
        }
      }
    });
  },

  pendingContentSafetyTickets() {
    const tickets = wx.getStorageSync(CONTENT_SAFETY_TICKETS_KEY);
    return Array.isArray(tickets) ? tickets.filter(Boolean) : [];
  },

  rememberContentSafetyTicket(ticket) {
    const tickets = this.pendingContentSafetyTickets();
    if (ticket && tickets.indexOf(ticket) < 0) {
      tickets.push(ticket);
      wx.setStorageSync(CONTENT_SAFETY_TICKETS_KEY, tickets.slice(-10));
    }
  },

  forgetContentSafetyTicket(ticket) {
    wx.setStorageSync(CONTENT_SAFETY_TICKETS_KEY, this.pendingContentSafetyTickets().filter((item) => item !== ticket));
    if (this._contentSafetyTimers && this._contentSafetyTimers[ticket]) {
      clearTimeout(this._contentSafetyTimers[ticket]);
      delete this._contentSafetyTimers[ticket];
    }
  },

  resumeContentSafetyChecks() {
    this.pendingContentSafetyTickets().forEach((ticket) => this.checkContentSafetyTicket(ticket, 0));
  },

  checkContentSafetyTicket(ticket, attempt) {
    api.get("/api/strings/content-safety-status", { ticket })
      .then((result) => {
        if (result.status === "pending") {
          if (attempt < 6) {
            this._contentSafetyTimers = this._contentSafetyTimers || {};
            this._contentSafetyTimers[ticket] = setTimeout(() => this.checkContentSafetyTicket(ticket, attempt + 1), 5000);
          }
          return;
        }
        this.forgetContentSafetyTicket(ticket);
        if (result.status === "blocked") {
          this.setData({ notice: "你发布的内容含违规信息" });
          wx.showToast({ title: "你发布的内容含违规信息", icon: "none" });
        } else if (result.status === "released") {
          this.setData({ notice: "内容安全审核已完成，老师复核后反馈会出现在「记录」里。" });
          this.loadRecent();
        } else if (result.status === "failed") {
          this.setData({ notice: "内容安全审核未完成，请重新提交。" });
        }
      })
      .catch(() => {});
  },

  submit() {
    if (this.data.submitting) return;
    if (!this.data.piece.trim()) { wx.showToast({ title: "请先填曲名", icon: "none" }); return; }
    if (!this.data.recordedPath) { wx.showToast({ title: "请先录音", icon: "none" }); return; }
    if (!this.data.selectedScoreId && !this.data.photoPath) {
      wx.showToast({ title: "请从曲库选择可分析曲目或添加谱面照片", icon: "none" });
      return;
    }
    this.setData({ submitting: true, notice: "" });
    const payload = {
      studentRef: api.studentRef(),
      piece: this.data.piece.trim(),
      pieceId: this.data.selectedPieceId,
      scoreId: this.data.selectedScoreId,
      instrument: this.data.instrument,
      audioSubmission: {
        name: this.data.recordedName || "practice.mp3",
        mimeType: this.data.recordedMimeType || "audio/mpeg"
      }
    };
    if (this.data.photoPath) {
      try {
        const base64 = wx.getFileSystemManager().readFileSync(this.data.photoPath, "base64");
        const imageExtension = ((this.data.photoPath.match(/\.([a-zA-Z0-9]+)(?:$|[?#])/) || [])[1] || "jpg").toLowerCase();
        if (imageExtension !== "jpg" && imageExtension !== "jpeg" && imageExtension !== "png") {
          this.setData({ submitting: false });
          wx.showToast({ title: "请使用 JPG 或 PNG 图片", icon: "none" });
          return;
        }
        const mimeType = imageExtension === "png" ? "image/png" : "image/jpeg";
        const fileExtension = imageExtension === "jpeg" ? "jpg" : imageExtension;
        payload.scorePhotoDataUrl = "data:" + mimeType + ";base64," + base64;
        payload.scorePhotoSubmission = { name: "score." + fileExtension, mimeType };
      } catch (err) {
        // 照片读取失败不阻断录音提交
      }
    }
    api.uploadAudio(this.data.recordedPath, { payload: JSON.stringify(payload) })
      .then((res) => {
        if (res && res.moderationPending && res.moderationTicket) {
          this.rememberContentSafetyTicket(res.moderationTicket);
          this.setData({
            submitting: false,
            notice: "内容安全审核中，审核通过后会出现在「记录」里。",
            recordedPath: "",
            recordedName: "",
            recordedMimeType: "",
            audioSource: "",
            photoPath: "",
            piece: "",
            selectedPieceId: "",
            selectedScoreId: "",
            recordSeconds: 0
          });
          this.checkContentSafetyTicket(res.moderationTicket, 0);
        } else if (res && res.analysis && res.analysis.submissionAccepted) {
          this.setData({
            submitting: false,
            notice: "提交成功!老师复核后,反馈会出现在下面和「记录」里。",
            recordedPath: "",
            recordedName: "",
            recordedMimeType: "",
            audioSource: "",
            photoPath: "",
            piece: "",
            selectedPieceId: "",
            selectedScoreId: "",
            recordSeconds: 0
          });
          this.loadRecent();
        } else {
          this.setData({ submitting: false });
          wx.showToast({ title: "提交未被接收", icon: "none" });
        }
      })
      .catch((error) => {
        this.setData({ submitting: false });
        if (error && error.data && error.data.code === "CONTENT_SAFETY_REJECTED") {
          wx.showToast({ title: "你发布的内容含违规信息", icon: "none" });
          return;
        }
        wx.showToast({ title: "提交失败,请稍后重试", icon: "none" });
      });
  },

  goRecords() {
    wx.switchTab({ url: "/pages/records/records" });
  },

  openItem(e) {
    wx.setStorageSync("currentFeedback", e.currentTarget.dataset.item);
    wx.navigateTo({ url: "/pages/feedback/feedback" });
  },

  onShareAppMessage() {
    return {
      title: "AI 弦乐练习 · 录下你的琴声",
      path: "/pages/upload/upload"
    };
  }
});

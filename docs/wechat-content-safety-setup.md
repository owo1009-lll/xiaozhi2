# 小程序内容安全配置

本项目的“小程序上传练习”链路会在服务端执行微信内容安全 2.0：

- 用户填写的曲名走 `msgSecCheck`；
- 用户拍摄或选择的谱子图片走 `mediaCheckAsync`；
- 图片在微信回调返回 `pass` 前只保存在私有待审核区，不会进入教师复核队列；
- `risky` 和 `review` 均不发布，小程序仅提示“你发布的内容含违规信息”。

## 一次性后台配置

在小程序管理后台完成以下设置：

1. 在“开发管理 / 开发设置”添加服务器域名 `https://api.stringinstrumentdiagnosis.icu`（request、upload、download 均添加）。
2. 在同一页的服务器 IP 白名单中加入运行 `server.js` 这台机器的公网出口 IP；IP 变更后需要同步更新。
3. 在“开发 / 开发管理 / 消息推送配置”填写：
   - URL：`https://api.stringinstrumentdiagnosis.icu/api/wechat/content-safety-callback`
   - Token：自行生成的随机长字符串
   - 数据格式：JSON
   - 消息加解密方式：安全模式
   - EncodingAESKey：后台生成的 43 位密钥

不要把 AppSecret、Token 或 EncodingAESKey 发到聊天中，也不要写进小程序源码。

## 服务器环境变量

将 `.env.example` 中以下变量复制到本机未提交的 `.env`，并填入小程序后台对应值：

```dotenv
WECHAT_MINIPROGRAM_APPID=...
WECHAT_MINIPROGRAM_SECRET=...
WECHAT_CONTENT_SAFETY_PUBLIC_BASE_URL=https://api.stringinstrumentdiagnosis.icu
WECHAT_CONTENT_SAFETY_CALLBACK_TOKEN=...
WECHAT_CONTENT_SAFETY_ENCODING_AES_KEY=...
```

重启公开后端后，先在后台保存“消息推送配置”，确认微信的 URL 校验通过；再从开发者工具预览版提交一张正常谱子照片。图片审核回调最多可能需要 30 分钟，审核通过后才会出现在“记录”。

若内容安全服务未配置、微信接口报错或审核超时，服务器会拒绝发布，不会把图片送进教师复核队列。

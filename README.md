# 小红书创作数据同步

Chrome 浏览器插件（Manifest V3），将**小红书创作服务平台**的数据自动同步至**飞书多维表格**。

## 功能特性

- **账号概览**：曝光量、观看量、互动数据、涨粉数据、发布数据（支持近 7 天 / 近 30 天）
- **内容分析**：笔记列表及各项指标（曝光、阅读、点赞、评论、收藏、分享等）
- **粉丝数据**：总粉丝数、新增粉丝、流失粉丝趋势
- **飞书同步**：一键将数据写入飞书多维表格，支持批量创建和更新

## 技术方案

小红书 API 使用动态签名（`X-s`、`X-s-common`、`X-t`），无法直接调用。本插件通过在页面注入脚本，拦截页面自身的 API 请求响应来获取数据：

```
页面 JS 发起 API 请求（自带签名）
      ↓
bridge 脚本拦截 XHR/fetch 响应 → 缓存数据
      ↓
content script 读取缓存 → 传递给 side panel
      ↓
side panel 预览数据 → 同步至飞书
```

## 安装使用

### 1. 加载插件

1. 在 Chrome 地址栏输入 `chrome://extensions/`，开启**开发者模式**
2. 点击**加载已解压的扩展程序**，选择本项目目录

### 2. 获取数据

1. 在浏览器中打开 [小红书创作服务平台](https://creator.xiaohongshu.com) 并登录
2. 点击插件图标，打开侧边栏
3. 选择数据范围（账号概览 / 内容分析 / 粉丝数据 / 全部）
4. 点击**获取数据**，插件会自动导航并拦截 API 数据
5. 数据以 JSON 格式展示在预览区域

### 3. 同步至飞书

1. 创建一个[飞书自建应用](https://open.feishu.cn/app)，获取 **App ID** 和 **App Secret**
2. 为应用添加 `bitable:app` 读写权限
3. 创建飞书多维表格，将应用添加为协作者
4. 在插件侧边栏填写飞书配置（App ID、App Secret、多维表格链接）
5. 点击**同步到飞书**

## 项目结构

```
├── manifest.json              # 插件配置（MV3）
├── service-worker.js          # Background：飞书 API 集成与数据写入
├── inject/
│   └── xhs-bridge.js         # MAIN world 注入，拦截页面 API 响应
├── content/
│   └── content-script.js     # ISOLATED world，与 bridge 通信
├── sidepanel/
│   ├── panel.html             # 侧边栏 UI
│   ├── panel.js               # 侧边栏逻辑
│   └── panel.css              # 样式
├── lib/
│   ├── feishu-api.js          # 飞书开放 API 封装
│   ├── utils.js               # 工具函数
│   └── xhs-api.js             # 占位文件
├── popup/
│   └── popup.html             # 旧 popup（已弃用，仅用于打开侧边栏）
└── icons/                     # 插件图标
```

## 开发状态

### 已完成

- Chrome Extension MV3 基础架构
- Side Panel UI（数据范围选择、进度展示、数据预览、飞书配置表单）
- API 响应拦截（XHR/fetch monkey-patch）
- 页面自动导航和刷新
- 飞书 API 封装（token、Bitable CRUD、批量读写）
- 飞书写入框架

### 待开发

- 数据处理与清洗（原始 JSON → 结构化数据）
- 飞书字段映射优化（根据实际 API 响应调整表结构）
- 内容分析翻页（当前仅拦截第一页）
- 定时自动同步
- 错误处理完善
- 打包分发

## 注意事项

- 必须在浏览器中登录小红书创作平台，插件依赖浏览器 Cookie
- 获取数据时会自动导航/刷新页面，会打断当前操作
- 飞书自建应用需要 `bitable:app` 权限，并添加为多维表格协作者

## License

MIT

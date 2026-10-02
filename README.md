# K-LINE

用 K 线展示声音变化的网页。支持扬声器 / 系统音频、内置试听和本地音频，无需后端。

## 两种模式

- **声音走势**：声音变化带动 K 线涨跌。静音后在 2 秒内逐渐跌到谷底，声音恢复后继续变化。
- **频响 K 线**：按频率排列 K 线，连接成实时频谱曲线。显示 100 Hz–16 kHz，静音时保持居中的水平直线。

支持平滑度调节、全屏和悬停查看数值。这里的 K 线用于声音可视化，不代表真实行情。

## 怎么用

1. 打开网页，选择音源。
2. 使用系统音频时，点击「连接扬声器」，选择共享来源并勾选「共享音频」。
3. 也可以选择「内置试听」，或选择「本地音频」后打开文件；拖入音频文件也可以。
4. 切换顶部的模式，根据需要调整平滑度等参数。

系统音频需要通过 HTTPS 或 localhost 打开，能否共享音频取决于浏览器和系统。如果没有声音，先检查是否勾选了「共享音频」。

声音在浏览器本地分析，不上传音频。共享窗口由浏览器要求打开，网页不显示或录制共享画面。

## 部署到云端（推荐）

这是静态网页，不用自己准备服务器。新手可以直接通过 Cloudflare 网页上传；已有 GitHub 仓库也可以使用 GitHub Pages。

部署只需要这四个文件，放在同一个目录：

```text
index.html
styles.css
app.js
signal.js
```

### Cloudflare（网页上传，适合新手）

不用安装 Node.js，也不用输入命令。

1. 把上面的四个文件放进同一个文件夹，确保 `index.html` 就在文件夹根目录。
2. 打开 [Cloudflare Drop](https://www.cloudflare.com/drop/)，把整个文件夹或它的 ZIP 压缩包拖进去。
3. 等待上传完成，打开页面给出的 `workers.dev` 网址。
4. 点击 **Claim（认领）**，登录或注册 Cloudflare 账号，把网站保留到自己的账号下。

未认领的网址只保留 **1 小时**，长期使用需要完成第 4 步。认领后可以在 Cloudflare 控制台的 **Workers & Pages** 中管理网站。

[Cloudflare 官方上传说明](https://developers.cloudflare.com/changelog/post/2026-07-08-cloudflare-drag-and-drop/)

### GitHub Pages

适合直接把 GitHub 仓库发布成网页。

1. 把项目上传到 GitHub 仓库。使用免费账号时，选择公开仓库。
2. 进入仓库的 **Settings → Pages**。
3. 在 **Source** 中选择 **Deploy from a branch**，选择存放项目的分支（通常是 `main`）和 **/(root)**，点击 **Save**。
4. 等待发布完成，打开 Pages 页面给出的网址。

之后把修改推送到同一分支，网页就会自动更新。

[GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 本地运行

只想在自己电脑上使用，可以在项目目录执行：

```sh
python -m http.server 8080 --bind 127.0.0.1
```

然后打开 [localhost:8080](http://localhost:8080)。电脑需已安装 Python。

也可以直接打开 `index.html` 使用内置试听或本地音频。

## 开发测试

安装 Node.js 后，在项目目录执行：

```sh
node --test tests/audio-lifecycle.test.cjs tests/signal.test.cjs
```

## 灵感来源

- [Bilibili 视频](https://www.bilibili.com/video/BV1CeYR65Evf)
- [FX战士久留美（萌娘百科）](https://zh.moegirl.org.cn/FX%E6%88%98%E5%A3%AB%E4%B9%85%E7%95%99%E7%BE%8E)

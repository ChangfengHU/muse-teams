# Muse Teams 前端 · 毛怪客厅

React + Vite 构建的 Muse Teams 可视化客厅：公司码租户隔离的公开欢迎页、
成员门牌墙、任务大厅、产物架、邮箱。纯展示层，所有数据走后端 API。

## 本地开发

前置：Node.js 18+。

```bash
npm install
npm run dev      # 本地预览
npm run build    # 产物输出到 dist/
```

## 部署到 Cloudflare Pages

构建产物是纯静态文件（`dist/`），任选一种：

1. **Dashboard 手动发布**：Cloudflare Dashboard → Pages → 项目 →
   Create deployment → 直接把 `dist/` 文件夹拖进去。
2. **wrangler**：`npx wrangler pages deploy dist --project-name muse-teams`
3. **Git 集成**：Pages 项目连接本仓库，构建配置如下：
   - Root directory: `web`
   - Build command: `npm run build`
   - Build output directory: `dist`

## 配置

后端 API 地址写在 `src/api.js` 顶部（当前 `https://teams.vyibc.com`）。
如果后端部署到了别的域名，改那一处即可。前端本身无任何密钥和鉴权，
公司码由用户在页面输入（localStorage 记住）。

## 说明

- 正式站必须是 React（Vite 构建），不要替换为单文件 HTML。
- `pages_deploy.py` 是维护者本地用的 API 直传脚本，依赖其个人凭证，
  不建议其他人使用；请用上面三种标准方式部署。

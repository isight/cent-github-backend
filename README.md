# Urodele Github Login

这是一个帮助用户使用Github App方式登录使用urodele创建的博客站点的项目[urodele-blog](https://github.com/apps/urodele-blog)，基于免费的cloudflare worker

# 如何使用

如果你想要创建私有的Github App来登录，可以fork本仓库，或者通过阅读[这篇文章](https://glink25.github.io/post/CloudFlare-Workers%E5%BF%AB%E9%80%9F%E4%BD%BF%E7%94%A8%E6%94%BB%E7%95%A5/)来了解如何使用CloudFlare来部署本项目

~~首先你需要使用urodele创建一个站点，然后向该项目创建一个PR，将你的博客域名 https://YOUR_NAME.github.io 增加到white_list中~~

> 处于安全考虑，暂不支持新增white_list，需要自己fork项目并使用cloudflare部署

PR通过后，在你的博客仓库urodele.config.ts中，填入如下配置：
```typescript
export const config = {
  github: {
    // ... other options
    logInUrl:
      "https://github-login.link-ai.workers.dev/api/oauth/authorize?redirect_uri=https://YOUR_NAME.github.io/login",
    logInAuthUrl: "https://github-login.link-ai.workers.dev/api/oauth/token",
  },
  // ... other options
}
```

之后即可在自己博客站点中使用Github App方式登录

> 如果要启用Urodele编辑功能，需要手动安装自己的Github App来授予特定仓库的编辑权限
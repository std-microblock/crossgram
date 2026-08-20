commit message 用 scope: detail 的格式，要有详细的单元测试和 e2e 测试

这个项目非常早期不需要考虑数据库/API Break，想改什么就改什么

在本项目同目录应该有 AyuGramDesktop 或 materialgram 的源码，可以用来参考

QQNT 的协议实现端应该在本项目同目录下的 qqnt-bridge 文件夹

代码修改流程：

1. 确认是否已在一个独立的 worktree，如果没有则创建（统一放在 CWD 的 .worktrees/ 目录下，不一定是 git 目录下！）
2. 在 worktree 内进行修改和测试
3. 提交 commit，并 rebase merge 到主分支
4. push 主分支
5. 删除 worktree 和创建的临时分支

如果主分支有其他更改，rebase 的时候需要保留这些更改（可以先 stash）

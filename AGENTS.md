做完一个部分自己 Commit + Push，message 用 scope: detail 的格式
要有详细的单元测试和 e2e 测试

这个项目非常早期不需要考虑数据库/API Break，想改什么就改什么

在本项目同目录（../）应该有 AyuGramDesktop 或 materialgram 的源码，可以用来参考

QQNT 的协议实现端应该在本项目同目录下的 qqnt-bridge 文件夹

同时可能有多个agent在工作，修改代码时先 checkout 出一个自己的 worktree，修改后测试前先确认主文件夹现在是不是主分支，如果不是则等待切换到主分支；如果是，则把主文件夹 checkout 到对应分支，进行测试，测试完成后自己合并到主分支，解决conflict，并删除 worktree 分支

合并修改的时候尽可能使用 rebase，可以保持历史清爽

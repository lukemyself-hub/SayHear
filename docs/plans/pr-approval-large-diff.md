# 大 PR 完整取证

根因：#333 的1077文件超过GitHub整份diff接口300文件上限；现有controller还将diff限制800KB并拒绝无内容的binary marker。只放宽字节限制仍无法取得完整证据。

目标：固定启动器能够为#333生成完整、可审计的审核包，保留#301关闭排除与现有门禁。

实现：
1. 普通PR保留现有完整unified diff快速路径；超限、二进制或截断时回退到认证API。
2. 分页files与当前changed_files数量匹配、去重；读取compare的merge-base和已钉住commit tree，要求tree未截断，并交叉检查全部树差异与file manifest。
3. 按tree固定的blob SHA读取全量新旧内容，验证Git blob SHA与大小。只读取数据，不checkout、不执行PR代码、不安装依赖。内容缓存是不可信输入，每次按认证API返回SHA复核。
4. 确定性生成可由Git apply验证的完整文件patch，包括Git binary literal patch，绑定全部内容和文件mode，不把Binary files differ摘要标成完整。
5. 限制文件数、单blob/总字节、并发与输出大小；缺失、SHA不一致、截断和身份漂移均保留incomplete_diff，记录明确原因。prepare即使不完整也提供诊断包，不能批准。
6. 测试完整性、隐瞒文件、cache污染、权限、二进制、无末尾换行、rename与mode；用固定SHA的真实#333 metadata+Git对象数据验证，不执行PR代码。
7. 独立检查改动、类型检查、构建安装助手。按照既有A方案，由Luke在自己的终端安装root-owned bundle；安装后仅status/prepare验收本次功能，不自动提交对#333的批准或合入。

保留前一任务的未提交改动，不提交、不推送、不更改#333代码/Issue标签。

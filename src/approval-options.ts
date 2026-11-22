// DEPS: 无
// RESPONSIBILITY: 定义老板审批裁决的固定选项
// MODULE: secretary
// ---
export const APPROVAL_OPTIONS = [
  { id: 'allow', label: '允许本次操作', consequence: '仅放行这一次工具调用', recommended: false },
  { id: 'reject', label: '拒绝本次操作', consequence: '把拒绝结果返回原会话', recommended: true },
] as const

/** 独立像素办公室浏览器入口：设置深胡桃底色并挂载 StageApp。 */
import { createRoot } from 'react-dom/client'
import { StageApp } from './stage-app.tsx'

if (typeof document !== 'undefined') {
  document.body.style.margin = '0'
  document.body.style.background = '#201A18'
  const rootEl = document.getElementById('root')
  if (rootEl) createRoot(rootEl).render(<StageApp />)
}

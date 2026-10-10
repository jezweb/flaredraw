import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const themeHook = readFileSync(join(root, 'src/client/hooks/useTheme.ts'), 'utf8')
const globalCss = readFileSync(join(root, 'src/index.css'), 'utf8')

const usesHtmlDarkToggle = themeHook.includes("document.documentElement.classList.toggle('dark'")
const hasClassBasedDarkVariant = globalCss.includes('@custom-variant dark')

if (usesHtmlDarkToggle && !hasClassBasedDarkVariant) {
  throw new Error(
    'Theme hook toggles html.dark, but Tailwind dark variant is not configured to use the dark class.'
  )
}

console.log('Theme dark-mode configuration is consistent.')

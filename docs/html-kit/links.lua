-- 生成 HTML 时的两件事：文档之间的相对链接（目标也会生成 HTML 时，把 .md 换成 .html；其余链接原样保留），以及给表格包一层滚动容器。
-- build-html.sh 传入两项元数据：srcdir（当前文档相对 docs/ 的目录）和 converted（这次生成 HTML 的全部文档，相对 docs/）。

local converted = {}
local srcdir = ''

local function normalize(path)
  local parts = {}
  for part in path:gmatch('[^/]+') do
    if part == '..' then
      if #parts > 0 and parts[#parts] ~= '..' then table.remove(parts) else table.insert(parts, '..') end
    elseif part ~= '.' then
      table.insert(parts, part)
    end
  end
  return table.concat(parts, '/')
end

function Meta(meta)
  if meta.srcdir then srcdir = pandoc.utils.stringify(meta.srcdir) end
  if meta.converted then
    for item in pandoc.utils.stringify(meta.converted):gmatch('[^,]+') do converted[item] = true end
  end
end

function Link(el)
  local target = el.target
  if target:match('^%a[%w+.-]*:') or target:match('^#') then return nil end
  local path, anchor = target:match('^([^#]*)(.*)$')
  if not path:match('%.md$') then return nil end
  local resolved = normalize((srcdir ~= '' and (srcdir .. '/') or '') .. path)
  if converted[resolved] then
    el.target = path:gsub('%.md$', '.html') .. anchor
  end
  return el
end

-- 表格包一层可横向滚动的容器：表格本身按正文宽度排，实在放不下时只在表格里滚动，不撑宽页面。
-- 表格里的行内代码（多是路径、文件名、函数签名）只在 / . _ - , 之后换行，不在单词中间断开。
local function escape(text)
  return (text:gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'))
end
local function breakable(code)
  local html = escape(code.text):gsub('([/%._%-,])', '%1<wbr>')
  return pandoc.RawInline('html', '<code>' .. html .. '</code>')
end
function Table(el)
  return pandoc.Div({ el:walk({ Code = breakable }) }, pandoc.Attr('', { 'table-wrap' }))
end

-- 图：点一下在新页打开原尺寸（宽图缩小后还能看清）；延迟加载；截图（assets/screens/）加一个 screen 类，样式上带细边框。
function Image(el)
  el.attributes.loading = 'lazy'
  return pandoc.Link({ el }, el.src, '', pandoc.Attr('', { 'figure-link' }, { { 'target', '_blank' }, { 'rel', 'noopener' } }))
end
function Figure(el)
  local screen = false
  el:walk({ Image = function(img) if img.src:match('assets/screens/') then screen = true end end })
  if screen then el.classes:insert('screen') end
  return el
end

return { { Meta = Meta }, { Link = Link, Table = Table, Figure = Figure }, { Image = Image } }

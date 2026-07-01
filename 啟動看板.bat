[build]
  publish = "."
  functions = "netlify/functions"

# 手機瀏覽器開根網址時導向 mobile.html
[[redirects]]
  from = "/"
  to = "/mobile.html"
  status = 302
  conditions = {User-Agent = ["*iPhone*", "*Android*", "*Mobile*"]}

[[headers]]
  for = "/*"
  [headers.values]
    Access-Control-Allow-Origin = "*"

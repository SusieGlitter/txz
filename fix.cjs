const fs = require('fs');
let content = fs.readFileSync('src/utils/passRenderer.ts', 'utf8');
content = content.replace(/\}\n\}\n$/, '}\n');
fs.writeFileSync('src/utils/passRenderer.ts', content);

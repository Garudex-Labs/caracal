const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'docusaurus.config.ts');
const content = fs.readFileSync(file, 'utf8');

const hasColor = /backgroundColor:\s*['"]#9BD34D['"]/i.test(content);
const hasMessage = /<strong>\s*Documentation is currently under maintenance and is being prepared for the v1\.0\.0 release soon\.\s*<\/strong>/i.test(content);

if (hasColor && hasMessage) {
  console.log('Announcement bar test: OK');
  process.exit(0);
} else {
  console.error('Announcement bar test: FAIL');
  if (!hasColor) console.error(' - missing backgroundColor: #9BD34D');
  if (!hasMessage) console.error(' - missing expected announcement message');
  process.exit(2);
}

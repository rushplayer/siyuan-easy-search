from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parent.parent
with ZipFile(root / 'package.zip', 'w', ZIP_DEFLATED) as archive:
    for name in ('index.js', 'plugin.json', 'README.md', 'LICENSE', 'CHANGELOG.md'):
        archive.write(root / name, name)
    for file in sorted((root / 'i18n').glob('*.json')):
        archive.write(file, str(file.relative_to(root)))
print('Created package.zip')

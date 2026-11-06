"""Build a dependency-free VSIX using the documented VSIX/VS Code manifest format."""
from pathlib import Path
import json
import zipfile
from xml.sax.saxutils import escape

root = Path(__file__).resolve().parents[1]
p = json.loads((root / 'package.json').read_text())
out = root / 'dist' / f"{p['name']}-{p['version']}.vsix"
out.parent.mkdir(exist_ok=True)
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
 <Metadata><Identity Language="en-US" Id="{p['name']}" Version="{p['version']}" Publisher="{p['publisher']}"/>
 <DisplayName>{p['displayName']}</DisplayName><Description xml:space="preserve">{escape(p['description'])}</Description>
 <Tags>ssh,magpie,remote,agent</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags>
 <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{p['engines']['vscode']}"/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/>
 <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value=""/>
 <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/></Properties></Metadata>
 <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
 <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
 <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
 <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/></Assets>
</PackageManifest>'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/>
<Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/>
<Default Extension="txt" ContentType="text/plain"/>
<Override PartName="/extension/LICENSE" ContentType="text/plain"/></Types>'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('[Content_Types].xml', types)
    for name in ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']:
        z.write(root / name, f'extension/{name}')
    for file in sorted((root / 'src').glob('*.js')):
        z.write(file, f'extension/src/{file.name}')
print(out)

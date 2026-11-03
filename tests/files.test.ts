import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFile, normalizeAgentFilePath, resolveObjectKey } from "../src/lib/files";
import { artifactRenderKey, prepareArtifactContent } from "../src/lib/artifact-content";

test("mount paths map into the configured OSS prefix, including Unicode and nested folders", () => {
  assert.equal(resolveObjectKey("/mnt/oss/data/reports/季度总结.pptx"), "agentcore/ppts/reports/季度总结.pptx");
  assert.equal(resolveObjectKey("sandbox:/mnt/oss/data/hello%20world.pdf", "private/files/"), "private/files/hello world.pdf");
  assert.equal(normalizeAgentFilePath("/mnt/oss/data/你好.pptx"), "/mnt/oss/data/你好.pptx");
});

test("traversal, encoded separators, other mounts and URLs are rejected", () => {
  for (const path of ["/mnt/oss/data/../secret.txt", "/mnt/oss/data/%2e%2e/a.txt", "/mnt/oss/data/%252e%252e/a", "/mnt/oss/data/a%2fb", "/mnt/oss/data/a\\b", "/mnt/oss/data//a", "/mnt/oss/data/", "/mnt/oss/database/a", "https://example.com/a", "oss://bucket/file", "/etc/passwd", "/mnt/oss/data/a\nb"]) assert.throws(() => normalizeAgentFilePath(path), (error) => error instanceof Error, path);
  assert.throws(() => resolveObjectKey("/mnt/oss/data/a.txt", "../other"));
});

test("file types use safe MIME values and restrict large text previews", () => {
  assert.equal(describeFile("/mnt/oss/data/a.PPTX").kind, "pptx");
  assert.equal(describeFile("/mnt/oss/data/a.png").contentType, "image/png");
  assert.equal(describeFile("/mnt/oss/data/demo.MP4").kind, "video");
  assert.equal(describeFile("/mnt/oss/data/demo.mp4").contentType, "video/mp4");
  assert.equal(describeFile("/mnt/oss/data/a.html").contentType, "text/plain; charset=utf-8");
  assert.equal(describeFile("/mnt/oss/data/a.svg").kind, "image");
  assert.equal(describeFile("/mnt/oss/data/a.svg").contentType, "image/svg+xml");
  assert.equal(describeFile("/mnt/oss/data/a.ppt").kind, "unsupported");
  assert.equal(describeFile("/mnt/oss/data/a.txt").previewLimit, 2 * 1024 * 1024);
  for (const extension of ["MD", "markdown"]) {
    const file = describeFile(`/mnt/oss/data/report.${extension}`);
    assert.equal(file.kind, "markdown");
    assert.equal(file.previewLimit, 2 * 1024 * 1024);
    assert.equal(file.contentType, "text/plain; charset=utf-8");
  }
  assert.equal(describeFile("/mnt/oss/data/report.DOCX").kind, "docx");
  assert.equal(describeFile("/mnt/oss/data/report.docx").contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(describeFile("/mnt/oss/data/report.doc").kind, "unsupported");
});

test("Markdown links, sandbox links and inline paths produce renderer file components", () => {
  for (const content of ["[演示文稿](/mnt/oss/data/deck.pptx)", "[演示文稿](sandbox:/mnt/oss/data/deck.pptx)", "[有空格](</mnt/oss/data/my deck.pptx>)", "`/mnt/oss/data/deck.pptx`"]) {
    const transformed = prepareArtifactContent(content);
    assert.match(transformed, /<AgentFileArtifact filePath="%2Fmnt%2Foss%2Fdata%2F/);
  }
});

test("opaque file links render as file components without exposing mount paths", () => {
  const reference = "/f/f_1234567890123456789012";
  const transformed = prepareArtifactContent(`[季度总结.pptx](<${reference}>)`);
  assert.match(transformed, /AgentFileArtifact/);
  assert.match(transformed, /filePath="%2Ff%2Ff_1234567890123456789012"/);
  assert.doesNotMatch(transformed, /mnt\/oss|agenticfs/);
});

test("artifact render identity changes when a streamed file reference is replaced", () => {
  const stale = prepareArtifactContent("[国庆节快乐.pptx](</f/f_t3VGhBkI4q4inVvx6_T63g>)", true);
  const published = prepareArtifactContent("[国庆节快乐.pptx](</f/f_4Tj8T0vfqxhD-JKuPPMraQ>)", true);

  assert.notEqual(artifactRenderKey(stale), artifactRenderKey(published));
  assert.equal(artifactRenderKey(`${published}\n生成完成。`), artifactRenderKey(published));
});

test("declarative file tags accept only literal path/name attributes", () => {
  const transformed = prepareArtifactContent('<FileCard path="/mnt/oss/data/结果.pptx" name="发布方案" />');
  assert.match(transformed, /fileName="%E5%8F%91/);
  assert.doesNotMatch(transformed, /path=/);
  assert.equal(prepareArtifactContent('<FileCard path="/mnt/oss/data/a.pptx" onClick={() => fetch("evil")} />'), "[文件引用格式无效]");
  assert.equal(prepareArtifactContent('<FileCard path="/etc/passwd" />'), "[文件路径无效]");
});

test("image Markdown uses the authenticated artifact component, including spaces and parentheses", () => {
  const path = "/mnt/oss/data/users/example/二维码 (新版).png";
  const output = prepareArtifactContent(`![二维码](<${path}>)`, true);
  assert.match(output, /<AgentFileArtifact /);
  assert.ok(output.includes(`filePath="${encodeURIComponent(path)}"`));
  assert.doesNotMatch(output, /!\[/);
  assert.equal(prepareArtifactContent(`![二维码](<${path}`, true), "");
  const example = `\`\`\`markdown\n![二维码](<${path}>)\n\`\`\``;
  assert.equal(prepareArtifactContent(example), example);
  assert.doesNotMatch(prepareArtifactContent("![bad](/mnt/oss/data/../secret.png)"), /AgentFileArtifact/);
  assert.doesNotMatch(prepareArtifactContent("![outside](/tmp/image.png)"), /AgentFileArtifact/);
  const svgReference = "/f/f_1234567890123456789012";
  const svg = prepareArtifactContent(`![cat-on-tree.svg](<${svgReference}>)`);
  assert.match(svg, /<AgentFileArtifact /);
  assert.ok(svg.includes(`fileName="${encodeURIComponent("cat-on-tree.svg")}"`));
});

test("partial streamed tags are withheld, while fenced and inline examples remain literal", () => {
  assert.equal(prepareArtifactContent('文件已生成。\n<FileCard path="/mnt/oss/data/a'), "文件已生成。\n");
  assert.equal(prepareArtifactContent("[下载](/mnt/oss/data/part"), "");
  const fenced = '```xml\n<FileCard path="/mnt/oss/data/a.pptx" />\n```\n';
  assert.equal(prepareArtifactContent(fenced), fenced);
  const inline = '`<FileCard path="/mnt/oss/data/a.pptx" />`';
  assert.equal(prepareArtifactContent(inline), inline);
  assert.equal(prepareArtifactContent('```\n[文件](/mnt/oss/data/a.pptx)'), '```\n[文件](/mnt/oss/data/a.pptx)');
});

test("plain path fences and standalone paths become file cards, including Chinese and spaces", () => {
  const path = "/mnt/oss/data/大语言模型LLM全景解读.pptx";
  for (const input of [`\`\`\`\n${path}\n\`\`\``, `\`\`\`text\n${path}\n\`\`\`\n`, `~~~txt\r\n${path}\r\n~~~`, path, `已完成：\n\n${path}\n\n大小 1.1 MB`]) {
    const output = prepareArtifactContent(input);
    assert.ok(output.includes(`filePath="${encodeURIComponent(path)}"`));
    assert.doesNotMatch(output, /```|~~~/);
  }
  const multiple = prepareArtifactContent('```\n/mnt/oss/data/my report.pdf\n/mnt/oss/data/封面.png\n```');
  assert.equal((multiple.match(/<AgentFileArtifact /g) || []).length, 2);
  assert.ok(multiple.includes(encodeURIComponent('/mnt/oss/data/my report.pdf')));
});

test("path conversion waits for stream boundaries and preserves actual commands and examples", () => {
  const partial = '```\n/mnt/oss/data/报告.ppt';
  assert.equal(prepareArtifactContent(partial, true), partial);
  const completed = prepareArtifactContent(partial + 'x\n```', true);
  assert.ok(completed.includes('filePath="%2Fmnt%2Foss%2Fdata%2F%E6%8A%A5%E5%91%8A.pptx"'));
  assert.equal(prepareArtifactContent('/mnt/oss/data/报告.ppt', true), '/mnt/oss/data/报告.ppt');
  assert.match(prepareArtifactContent('/mnt/oss/data/报告.pptx\n', true), /<AgentFileArtifact/);
  assert.match(prepareArtifactContent('```\n/mnt/oss/data/报告.pptx', false), /<AgentFileArtifact/);
  for (const input of ['```bash\ncat /mnt/oss/data/a.txt\n```', '```js\nconst path = "/mnt/oss/data/a.txt";\n```', '```\n/mnt/oss/data/a.txt\n文件示例\n```', '```\n/mnt/oss/data/../a.txt\n```', '```\n/mnt/oss/data/\n```']) {
    assert.equal(prepareArtifactContent(input), input);
  }
});

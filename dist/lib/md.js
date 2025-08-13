import yaml from "js-yaml";
const YAML_BLOCK = /```yaml\n([\s\S]*?)\n```/m;
export function readYamlBlock(md, fallback) {
    const m = md.match(YAML_BLOCK);
    if (!m)
        return fallback;
    return yaml.load(m[1]);
}
export function writeYamlBlock(md, data) {
    const block = "```yaml\n" + yaml.dump(data, { lineWidth: 120 }) + "```";
    if (!md)
        return block + "\n";
    if (YAML_BLOCK.test(md))
        return md.replace(YAML_BLOCK, block);
    return (md.trim() + "\n\n" + block + "\n");
}

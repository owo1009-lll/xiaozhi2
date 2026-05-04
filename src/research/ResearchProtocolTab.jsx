import { RESEARCH_PROTOCOL, RESEARCH_TEMPLATE_LIBRARY } from "../researchProtocolData";
import { SectionTitle, TemplateDownloadLink } from "./ResearchAppSupport.jsx";

export default function ResearchProtocolTab() {
  return (
    <div className="protocol-layout">
      <section className="panel-card">
        <SectionTitle step="P1" title={RESEARCH_PROTOCOL.title} description={RESEARCH_PROTOCOL.summary} />
        <div className="protocol-stack">
          {RESEARCH_PROTOCOL.sections.map((section) => (
            <article key={section.title} className="protocol-card">
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="history-card">
          <h3>研究模板导出</h3>
          <p>下面的模板可直接导出为 Markdown，适合进一步整理为论文附件、伦理申请材料或研究执行文档。</p>
          <div className="summary-grid">
            {RESEARCH_TEMPLATE_LIBRARY.map((template) => (
              <article key={template.templateId} className="protocol-card">
                <h3>{template.title}</h3>
                <p>{template.description}</p>
                <div className="link-row">
                  <TemplateDownloadLink templateId={template.templateId}>导出模板</TemplateDownloadLink>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

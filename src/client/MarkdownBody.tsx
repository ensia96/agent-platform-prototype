import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const markdownRemarkPlugins = [remarkGfm, remarkBreaks];

const markdownComponents: Components = {
  a({ node: _node, href, children, target: _target, rel: _rel, ...props }) {
    if (!href) {
      return <span className="markdownBlockedLink">{children}</span>;
    }
    const external = isExternalHttpUrl(href);
    return (
      <a {...props} href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>
        {children}
      </a>
    );
  },
  img({ node: _node, src, alt, title: _title }) {
    const label = alt?.trim() || "image";
    return (
      <span className="markdownImagePlaceholder">
        Image: {src ? <MarkdownImageLink href={src}>{label}</MarkdownImageLink> : <span>{label} (blocked)</span>}
      </span>
    );
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdownTableScroll">
        <table {...props} />
      </div>
    );
  }
};

export function MarkdownBody({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ? `markdownBody ${className}` : "markdownBody"}>
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={markdownRemarkPlugins}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function safeMarkdownUrl(url: string): string {
  const value = url.trim();
  if (!value || value.startsWith("//")) {
    return "";
  }
  const safeValue = defaultUrlTransform(value);
  if (!safeValue) {
    return "";
  }
  const protocol = /^([a-z][a-z\d+.-]*):/i.exec(safeValue)?.[1]?.toLowerCase();
  return !protocol || protocol === "http" || protocol === "https" ? safeValue : "";
}

function MarkdownImageLink({ href, children }: { href: string; children: string }) {
  const external = isExternalHttpUrl(href);
  return (
    <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined}>
      {children}
    </a>
  );
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

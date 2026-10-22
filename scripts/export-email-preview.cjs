// Synthetic, self-contained review file. No network or production data.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../generated-artifacts/email-review");
const names = ["order-order_received", "order-order_confirmed", "order-access_ready",
  "newsletter-welcome", "contact-support-notification", "contact-visitor-ack", "support-booking", "smtp-test"];
const escape = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cards = names.map((name) => {
  const source = fs.readFileSync(path.join(root, name + ".html"), "utf8");
  const nonNavigable = source.replace(/<a\b/g, "<span").replace(/<\/a>/g, "</span>");
  return `<section><h2>${name.replaceAll("-", " ")}</h2><iframe title="${name}" sandbox="" srcdoc="${escape(nonNavigable)}"></iframe></section>`;
}).join("");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ConnectLive email template review</title>
<style>body{margin:0;padding:24px;background:#eef2f8;color:#16223c;font:16px Arial,sans-serif}main{max-width:800px;margin:auto}section{margin:28px 0}h2{font-size:17px;text-transform:capitalize}iframe{display:block;width:100%;height:1050px;border:1px solid #ccd4e2;background:white;border-radius:12px}p{line-height:1.6}button{padding:10px;border:1px solid #315ccb;border-radius:6px;background:white;color:#183986;margin-right:8px}</style>
<main><h1>ConnectLive email templates</h1><p>Eight message types with synthetic example data. No emails were sent. Browser previews do not certify Outlook, Gmail or inbox delivery. Links inside these sandboxed examples are disabled.</p><button onclick="document.querySelectorAll('iframe').forEach(f=>{f.style.maxWidth='375px'})">Mobile width</button><button onclick="document.querySelectorAll('iframe').forEach(f=>{f.style.maxWidth='100%'})">Desktop width</button>${cards}</main></html>`;
const out = path.resolve(__dirname, "../generated-artifacts/email-template-review.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(out);

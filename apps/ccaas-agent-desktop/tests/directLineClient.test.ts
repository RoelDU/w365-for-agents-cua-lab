import { describe, it, expect } from "vitest";
import { imageUrlsFromActivity } from "@/lib/directLineClient";

describe("imageUrlsFromActivity", () => {
  it("extracts an https image attachment via contentUrl", () => {
    const urls = imageUrlsFromActivity({
      attachments: [{ contentType: "image/png", contentUrl: "https://example.com/shot.png" }]
    });
    expect(urls).toEqual(["https://example.com/shot.png"]);
  });

  it("extracts a data-uri image attachment via contentUrl", () => {
    const dataUri = "data:image/jpeg;base64,/9j/abc";
    const urls = imageUrlsFromActivity({
      attachments: [{ contentType: "image/jpeg", contentUrl: dataUri }]
    });
    expect(urls).toEqual([dataUri]);
  });

  it("wraps a bare base64 content string into a data uri", () => {
    const urls = imageUrlsFromActivity({
      attachments: [{ contentType: "image/png", content: "AAAabc123" }]
    });
    expect(urls).toEqual(["data:image/png;base64,AAAabc123"]);
  });

  it("ignores non-image attachments", () => {
    const urls = imageUrlsFromActivity({
      attachments: [
        { contentType: "application/vnd.microsoft.card.adaptive", content: "{}" },
        { contentType: "image/png", contentUrl: "https://example.com/ok.png" }
      ]
    });
    expect(urls).toEqual(["https://example.com/ok.png"]);
  });

  it("extracts markdown-embedded images from text", () => {
    const urls = imageUrlsFromActivity({
      text: "Here is the screen ![shot](https://example.com/md.png) done"
    });
    expect(urls).toEqual(["https://example.com/md.png"]);
  });

  it("returns an empty array when there are no images", () => {
    expect(imageUrlsFromActivity({ text: "just narration, no image" })).toEqual([]);
    expect(imageUrlsFromActivity({})).toEqual([]);
  });
});

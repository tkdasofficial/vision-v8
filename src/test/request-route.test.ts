import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { routeRequest } from "@/lib/ai/request-route";

const STORY_BRIEF = `Analyze the following story carefully and convert it into a complete, chronologically accurate sequence of image-to-video generation prompts.
STORY
A young girl found a tiny seed beneath an ancient tree. She planted it in the middle of a dry village and watered it every day.
YOUR TASK
- Calculate the total duration before generating the final scene list.
- Generate Image-to-Video Prompts for every scene. Output the scene list in JSON if needed.`.repeat(2);

describe("request routing", () => {
  it("a long pasted story brief gets a written answer", () => {
    expect(routeRequest(STORY_BRIEF, "default").kind).toBe("chat");
  });
  it("Deep Thinking always answers in chat", () => {
    expect(routeRequest("create a qr code for my site", "deep").kind).toBe("chat");
  });
  it("writing a poem or story is a chat answer, not a file", () => {
    expect(routeRequest("write a poem about rain").kind).toBe("chat");
    expect(routeRequest("write a short story about a dragon").kind).toBe("chat");
  });
  it("asking for image prompts is a chat answer", () => {
    expect(routeRequest("create 5 image prompts for a sunset scene").kind).toBe("chat");
  });
  it("explicit tools still run as tools", () => {
    expect(routeRequest("make a qr code for https://example.com").kind).toBe("tool");
    expect(routeRequest("create a pdf of my resume").kind).toBe("tool");
  });
  it("explicit code files are exported", () => {
    expect(routeRequest("save the script as a py file")).toEqual({ kind: "code_export", language: "py" });
  });
  it("building a website is a project", () => {
    expect(routeRequest("build a landing page for my bakery").kind).toBe("project");
  });
  const UPLOAD = "/mnt/user-uploads/Analyze_the_following_story_carefully_and_pasted.md";
  it.skipIf(!existsSync(UPLOAD))("the user's real pasted brief gets a written answer", () => {
    expect(routeRequest(readFileSync(UPLOAD, "utf8"), "default").kind).toBe("chat");
  });
});

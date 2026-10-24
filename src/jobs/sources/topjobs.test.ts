import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAdPage } from "./topjobs.js";

const PAGE = "https://www.topjobs.lk/employer/JobAdvertismentServlet?rid=0&ac=DEFZZZ&jc=0001563567&ec=DEFZZZ";

// Shape of real pages: site chrome and logos around a #remark block holding the advert
const wrap = (remark: string) => `
  <html><body>
    <img src="../images/info.png"><div class="logo-holder"><img src="/logo/defzzz_small.gif"></div>
    <div id="remark" class="job-holder">${remark}</div>
    <img src="../images/application.png"><a href="mailto:support@topjobs.lk">help</a>
  </body></html>`;

describe("parseAdPage", () => {
    it("finds the poster of a picture advert and ignores logos and icons", () => {
        const page = parseAdPage(wrap(`<p><img src="/logo/DEFZZZ/7925c1273.png"></p>`), PAGE);

        assert.equal(page.text, "");
        assert.deepEqual(page.imageUrls, ["https://www.topjobs.lk/logo/DEFZZZ/7925c1273.png"]);
        assert.deepEqual(page.mailtos, []);
    });

    it("handles file names with spaces", () => {
        const page = parseAdPage(wrap(`<img src="/logo/0000000150/9580cRestaurant Manager.png">`), PAGE);
        assert.deepEqual(page.imageUrls, ["https://www.topjobs.lk/logo/0000000150/9580cRestaurant%20Manager.png"]);
    });

    it("reads the text and mailto link of a text advert", () => {
        const page = parseAdPage(
            wrap(`<h2>JOIN OUR FINANCE TEAM</h2><p>Key Responsibilities</p><a href="mailto:hr@acme.lk?subject=Finance">Apply</a>`),
            PAGE,
        );

        assert.match(page.text, /JOIN OUR FINANCE TEAM\s+Key Responsibilities/);
        assert.deepEqual(page.mailtos, ["hr@acme.lk"]);
    });

    it("never fetches images from other hosts or outside /logo/", () => {
        const page = parseAdPage(
            wrap(
                `<img src="https://evil.example/logo/x/y.png"><img src="http://169.254.169.254/logo/x/y.png">` +
                    `<img src="/images/banner.png"><img src="/logo/x/animated.gif"><img src="/logo/ok/a.jpg">`,
            ),
            PAGE,
        );

        assert.deepEqual(page.imageUrls, ["https://www.topjobs.lk/logo/ok/a.jpg"]);
    });

    it("looks at no more than three pictures, each once", () => {
        const imgs = ["a", "a", "b", "c", "d", "e"].map((n) => `<img src="/logo/E/${n}.png">`).join("");
        assert.equal(parseAdPage(wrap(imgs), PAGE).imageUrls.length, 3);
    });

    it("returns an empty result for a page without an advert body", () => {
        assert.deepEqual(parseAdPage("<html><body>Session expired</body></html>", PAGE), { text: "", mailtos: [], imageUrls: [] });
    });
});

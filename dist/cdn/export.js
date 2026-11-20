/*! html-to-image v1.11.13 | MIT License | Copyright (c) 2017-2025 W.Y.
    https://github.com/bubkoo/html-to-image
    The full license text is in experiments/vendor/html-to-image.LICENSE. */
export function createExport(deps = {}) {
  const {figures, toolbar, progress} = deps;
  /* The only way a module offers a capability: through the one global, at construction. */
  const registry = deps.env && deps.env.StandaloneDoc;

  const SNAPSHOT_LIB = "!function(t,e){\"object\"==typeof exports&&\"undefined\"!=typeof module?e(exports):\"function\"==typeof define&&define.amd?define([\"exports\"],e):e((t=\"undefined\"!=typeof globalThis?globalThis:t||self).htmlToImage={})}(this,(function(t){\"use strict\";function e(t,e,n,r){return new(n||(n=Promise))((function(i,o){function u(t){try{a(r.next(t))}catch(t){o(t)}}function c(t){try{a(r.throw(t))}catch(t){o(t)}}function a(t){var e;t.done?i(t.value):(e=t.value,e instanceof n?e:new n((function(t){t(e)}))).then(u,c)}a((r=r.apply(t,e||[])).next())}))}function n(t,e){var n,r,i,o,u={label:0,sent:function(){if(1&i[0])throw i[1];return i[1]},trys:[],ops:[]};return o={next:c(0),throw:c(1),return:c(2)},\"function\"==typeof Symbol&&(o[Symbol.iterator]=function(){return this}),o;function c(c){return function(a){return function(c){if(n)throw new TypeError(\"Generator is already executing.\");for(;o&&(o=0,c[0]&&(u=0)),u;)try{if(n=1,r&&(i=2&c[0]?r.return:c[0]?r.throw||((i=r.return)&&i.call(r),0):r.next)&&!(i=i.call(r,c[1])).done)return i;switch(r=0,i&&(c=[2&c[0],i.value]),c[0]){case 0:case 1:i=c;break;case 4:return u.label++,{value:c[1],done:!1};case 5:u.label++,r=c[1],c=[0];continue;case 7:c=u.ops.pop(),u.trys.pop();continue;default:if(!(i=u.trys,(i=i.length>0&&i[i.length-1])||6!==c[0]&&2!==c[0])){u=0;continue}if(3===c[0]&&(!i||c[1]>i[0]&&c[1]<i[3])){u.label=c[1];break}if(6===c[0]&&u.label<i[1]){u.label=i[1],i=c;break}if(i&&u.label<i[2]){u.label=i[2],u.ops.push(c);break}i[2]&&u.ops.pop(),u.trys.pop();continue}c=e.call(t,u)}catch(t){c=[6,t],r=0}finally{n=i=0}if(5&c[0])throw c[1];return{value:c[0]?c[1]:void 0,done:!0}}([c,a])}}}var r,i=(r=0,function(){return r+=1,\"u\".concat(\"0000\".concat((Math.random()*Math.pow(36,4)<<0).toString(36)).slice(-4)).concat(r)});function o(t){for(var e=[],n=0,r=t.length;n<r;n++)e.push(t[n]);return e}var u=null;function c(t){return void 0===t&&(t={}),u||(u=t.includeStyleProperties?t.includeStyleProperties:o(window.getComputedStyle(document.documentElement)))}function a(t,e){var n=(t.ownerDocument.defaultView||window).getComputedStyle(t).getPropertyValue(e);return n?parseFloat(n.replace(\"px\",\"\")):0}function s(t,e){void 0===e&&(e={});var n,r,i,o=e.width||(r=a(n=t,\"border-left-width\"),i=a(n,\"border-right-width\"),n.clientWidth+r+i),u=e.height||function(t){var e=a(t,\"border-top-width\"),n=a(t,\"border-bottom-width\");return t.clientHeight+e+n}(t);return{width:o,height:u}}var l=16384;function f(t,e){return void 0===e&&(e={}),t.toBlob?new Promise((function(n){t.toBlob(n,e.type?e.type:\"image/png\",e.quality?e.quality:1)})):new Promise((function(n){for(var r=window.atob(t.toDataURL(e.type?e.type:void 0,e.quality?e.quality:void 0).split(\",\")[1]),i=r.length,o=new Uint8Array(i),u=0;u<i;u+=1)o[u]=r.charCodeAt(u);n(new Blob([o],{type:e.type?e.type:\"image/png\"}))}))}function h(t){return new Promise((function(e,n){var r=new Image;r.onload=function(){r.decode().then((function(){requestAnimationFrame((function(){return e(r)}))}))},r.onerror=n,r.crossOrigin=\"anonymous\",r.decoding=\"async\",r.src=t}))}function d(t){return e(this,void 0,void 0,(function(){return n(this,(function(e){return[2,Promise.resolve().then((function(){return(new XMLSerializer).serializeToString(t)})).then(encodeURIComponent).then((function(t){return\"data:image/svg+xml;charset=utf-8,\".concat(t)}))]}))}))}function v(t,r,i){return e(this,void 0,void 0,(function(){var e,o,u;return n(this,(function(n){return e=\"http://www.w3.org/2000/svg\",o=document.createElementNS(e,\"svg\"),u=document.createElementNS(e,\"foreignObject\"),o.setAttribute(\"width\",\"\".concat(r)),o.setAttribute(\"height\",\"\".concat(i)),o.setAttribute(\"viewBox\",\"0 0 \".concat(r,\" \").concat(i)),u.setAttribute(\"width\",\"100%\"),u.setAttribute(\"height\",\"100%\"),u.setAttribute(\"x\",\"0\"),u.setAttribute(\"y\",\"0\"),u.setAttribute(\"externalResourcesRequired\",\"true\"),o.appendChild(u),u.appendChild(t),[2,d(o)]}))}))}var p=function(t,e){if(t instanceof e)return!0;var n=Object.getPrototypeOf(t);return null!==n&&(n.constructor.name===e.name||p(n,e))};function g(t,e,n,r){var i=\".\".concat(t,\":\").concat(e),o=n.cssText?function(t){var e=t.getPropertyValue(\"content\");return\"\".concat(t.cssText,\" content: '\").concat(e.replace(/'|\"/g,\"\"),\"';\")}(n):function(t,e){return c(e).map((function(e){var n=t.getPropertyValue(e),r=t.getPropertyPriority(e);return\"\".concat(e,\": \").concat(n).concat(r?\" !important\":\"\",\";\")})).join(\" \")}(n,r);return document.createTextNode(\"\".concat(i,\"{\").concat(o,\"}\"))}function m(t,e,n,r){var o=window.getComputedStyle(t,n),u=o.getPropertyValue(\"content\");if(\"\"!==u&&\"none\"!==u){var c=i();try{e.className=\"\".concat(e.className,\" \").concat(c)}catch(t){return}var a=document.createElement(\"style\");a.appendChild(g(c,n,o,r)),e.appendChild(a)}}var w=\"application/font-woff\",y=\"image/jpeg\",b={woff:w,woff2:w,ttf:\"application/font-truetype\",eot:\"application/vnd.ms-fontobject\",png:\"image/png\",jpg:y,jpeg:y,gif:\"image/gif\",tiff:\"image/tiff\",svg:\"image/svg+xml\",webp:\"image/webp\"};function S(t){var e=function(t){var e=/\\.([^./]*?)$/g.exec(t);return e?e[1]:\"\"}(t).toLowerCase();return b[e]||\"\"}function E(t){return-1!==t.search(/^(data:)/)}function x(t,e){return\"data:\".concat(e,\";base64,\").concat(t)}function C(t,r,i){return e(this,void 0,void 0,(function(){var e,o;return n(this,(function(n){switch(n.label){case 0:return[4,fetch(t,r)];case 1:if(404===(e=n.sent()).status)throw new Error('Resource \"'.concat(e.url,'\" not found'));return[4,e.blob()];case 2:return o=n.sent(),[2,new Promise((function(t,n){var r=new FileReader;r.onerror=n,r.onloadend=function(){try{t(i({res:e,result:r.result}))}catch(t){n(t)}},r.readAsDataURL(o)}))]}}))}))}var P={};function R(t,r,i){return e(this,void 0,void 0,(function(){var e,o,u,c,a;return n(this,(function(n){switch(n.label){case 0:if(e=function(t,e,n){var r=t.replace(/\\?.*/,\"\");return n&&(r=t),/ttf|otf|eot|woff2?/i.test(r)&&(r=r.replace(/.*\\//,\"\")),e?\"[\".concat(e,\"]\").concat(r):r}(t,r,i.includeQueryParams),null!=P[e])return[2,P[e]];i.cacheBust&&(t+=(/\\?/.test(t)?\"&\":\"?\")+(new Date).getTime()),n.label=1;case 1:return n.trys.push([1,3,,4]),[4,C(t,i.fetchRequestInit,(function(t){var e=t.res,n=t.result;return r||(r=e.headers.get(\"Content-Type\")||\"\"),function(t){return t.split(/,/)[1]}(n)}))];case 2:return u=n.sent(),o=x(u,r),[3,4];case 3:return c=n.sent(),o=i.imagePlaceholder||\"\",a=\"Failed to fetch resource: \".concat(t),c&&(a=\"string\"==typeof c?c:c.message),a&&console.warn(a),[3,4];case 4:return P[e]=o,[2,o]}}))}))}function T(t){return e(this,void 0,void 0,(function(){var e;return n(this,(function(n){return\"data:,\"===(e=t.toDataURL())?[2,t.cloneNode(!1)]:[2,h(e)]}))}))}function A(t,r){return e(this,void 0,void 0,(function(){var e,i,o,u;return n(this,(function(n){switch(n.label){case 0:return t.currentSrc?(e=document.createElement(\"canvas\"),i=e.getContext(\"2d\"),e.width=t.clientWidth,e.height=t.clientHeight,null==i||i.drawImage(t,0,0,e.width,e.height),[2,h(e.toDataURL())]):(o=t.poster,u=S(o),[4,R(o,u,r)]);case 1:return[2,h(n.sent())]}}))}))}function k(t,r){var i;return e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:return e.trys.push([0,3,,4]),(null===(i=null==t?void 0:t.contentDocument)||void 0===i?void 0:i.body)?[4,I(t.contentDocument.body,r,!0)]:[3,2];case 1:return[2,e.sent()];case 2:return[3,4];case 3:return e.sent(),[3,4];case 4:return[2,t.cloneNode(!1)]}}))}))}var L=function(t){return null!=t.tagName&&\"SVG\"===t.tagName.toUpperCase()};function N(t,e,n){return p(e,Element)&&(function(t,e,n){var r=e.style;if(r){var i=window.getComputedStyle(t);i.cssText?(r.cssText=i.cssText,r.transformOrigin=i.transformOrigin):c(n).forEach((function(n){var o=i.getPropertyValue(n);if(\"font-size\"===n&&o.endsWith(\"px\")){var u=Math.floor(parseFloat(o.substring(0,o.length-2)))-.1;o=\"\".concat(u,\"px\")}p(t,HTMLIFrameElement)&&\"display\"===n&&\"inline\"===o&&(o=\"block\"),\"d\"===n&&e.getAttribute(\"d\")&&(o=\"path(\".concat(e.getAttribute(\"d\"),\")\")),r.setProperty(n,o,i.getPropertyPriority(n))}))}}(t,e,n),function(t,e,n){m(t,e,\":before\",n),m(t,e,\":after\",n)}(t,e,n),function(t,e){p(t,HTMLTextAreaElement)&&(e.innerHTML=t.value),p(t,HTMLInputElement)&&e.setAttribute(\"value\",t.value)}(t,e),function(t,e){if(p(t,HTMLSelectElement)){var n=e,r=Array.from(n.children).find((function(e){return t.value===e.getAttribute(\"value\")}));r&&r.setAttribute(\"selected\",\"\")}}(t,e)),e}function I(t,r,i){return e(this,void 0,void 0,(function(){return n(this,(function(u){return i||!r.filter||r.filter(t)?[2,Promise.resolve(t).then((function(t){return function(t,r){return e(this,void 0,void 0,(function(){return n(this,(function(e){return p(t,HTMLCanvasElement)?[2,T(t)]:p(t,HTMLVideoElement)?[2,A(t,r)]:p(t,HTMLIFrameElement)?[2,k(t,r)]:[2,t.cloneNode(L(t))]}))}))}(t,r)})).then((function(i){return function(t,r,i){var u,c;return e(this,void 0,void 0,(function(){var e;return n(this,(function(n){switch(n.label){case 0:return L(r)?[2,r]:(e=[],0===(e=null!=(a=t).tagName&&\"SLOT\"===a.tagName.toUpperCase()&&t.assignedNodes?o(t.assignedNodes()):p(t,HTMLIFrameElement)&&(null===(u=t.contentDocument)||void 0===u?void 0:u.body)?o(t.contentDocument.body.childNodes):o((null!==(c=t.shadowRoot)&&void 0!==c?c:t).childNodes)).length||p(t,HTMLVideoElement)?[2,r]:[4,e.reduce((function(t,e){return t.then((function(){return I(e,i)})).then((function(t){t&&r.appendChild(t)}))}),Promise.resolve())]);case 1:return n.sent(),[2,r]}var a}))}))}(t,i,r)})).then((function(e){return N(t,e,r)})).then((function(t){return function(t,r){return e(this,void 0,void 0,(function(){var e,i,o,u,c,a,s,l,f,h,d,v,p;return n(this,(function(n){switch(n.label){case 0:if(0===(e=t.querySelectorAll?t.querySelectorAll(\"use\"):[]).length)return[2,t];i={},p=0,n.label=1;case 1:return p<e.length?(o=e[p],(u=o.getAttribute(\"xlink:href\"))?(c=t.querySelector(u),a=document.querySelector(u),c||!a||i[u]?[3,3]:(s=i,l=u,[4,I(a,r,!0)])):[3,3]):[3,4];case 2:s[l]=n.sent(),n.label=3;case 3:return p++,[3,1];case 4:if((f=Object.values(i)).length){for(h=\"http://www.w3.org/1999/xhtml\",(d=document.createElementNS(h,\"svg\")).setAttribute(\"xmlns\",h),d.style.position=\"absolute\",d.style.width=\"0\",d.style.height=\"0\",d.style.overflow=\"hidden\",d.style.display=\"none\",v=document.createElementNS(h,\"defs\"),d.appendChild(v),p=0;p<f.length;p++)v.appendChild(f[p]);t.appendChild(d)}return[2,t]}}))}))}(t,r)}))]:[2,null]}))}))}var D=/url\\((['\"]?)([^'\"]+?)\\1\\)/g,H=/url\\([^)]+\\)\\s*format\\(([\"']?)([^\"']+)\\1\\)/g,M=/src:\\s*(?:url\\([^)]+\\)\\s*format\\([^)]+\\)[,;]\\s*)+/g;function F(t,r,i,o,u){return e(this,void 0,void 0,(function(){var e,c,a,s;return n(this,(function(n){switch(n.label){case 0:return n.trys.push([0,5,,6]),e=i?function(t,e){if(t.match(/^[a-z]+:\\/\\//i))return t;if(t.match(/^\\/\\//))return window.location.protocol+t;if(t.match(/^[a-z]+:/i))return t;var n=document.implementation.createHTMLDocument(),r=n.createElement(\"base\"),i=n.createElement(\"a\");return n.head.appendChild(r),n.body.appendChild(i),e&&(r.href=e),i.href=t,i.href}(r,i):r,c=S(r),a=void 0,u?[4,u(e)]:[3,2];case 1:return s=n.sent(),a=x(s,c),[3,4];case 2:return[4,R(e,c,o)];case 3:a=n.sent(),n.label=4;case 4:return[2,t.replace((l=r,f=l.replace(/([.*+?^${}()|\\[\\]\\/\\\\])/g,\"\\\\$1\"),new RegExp(\"(url\\\\(['\\\"]?)(\".concat(f,\")(['\\\"]?\\\\))\"),\"g\")),\"$1\".concat(a,\"$3\"))];case 5:return n.sent(),[3,6];case 6:return[2,t]}var l,f}))}))}function V(t){return-1!==t.search(D)}function q(t,r,i){return e(this,void 0,void 0,(function(){var e,o;return n(this,(function(n){return V(t)?(e=function(t,e){var n=e.preferredFontFormat;return n?t.replace(M,(function(t){for(;;){var e=H.exec(t)||[],r=e[0],i=e[2];if(!i)return\"\";if(i===n)return\"src: \".concat(r,\";\")}})):t}(t,i),o=function(t){var e=[];return t.replace(D,(function(t,n,r){return e.push(r),t})),e.filter((function(t){return!E(t)}))}(e),[2,o.reduce((function(t,e){return t.then((function(t){return F(t,e,r,i)}))}),Promise.resolve(e))]):[2,t]}))}))}function U(t,r,i){var o;return e(this,void 0,void 0,(function(){var e,u;return n(this,(function(n){switch(n.label){case 0:return(e=null===(o=r.style)||void 0===o?void 0:o.getPropertyValue(t))?[4,q(e,null,i)]:[3,2];case 1:return u=n.sent(),r.style.setProperty(t,u,r.style.getPropertyPriority(t)),[2,!0];case 2:return[2,!1]}}))}))}function j(t,r){return e(this,void 0,void 0,(function(){var e,i;return n(this,(function(n){switch(n.label){case 0:return[4,U(\"background\",t,r)];case 1:return n.sent()?[3,3]:[4,U(\"background-image\",t,r)];case 2:n.sent(),n.label=3;case 3:return[4,U(\"mask\",t,r)];case 4:return(i=n.sent())?[3,6]:[4,U(\"-webkit-mask\",t,r)];case 5:i=n.sent(),n.label=6;case 6:return(e=i)?[3,8]:[4,U(\"mask-image\",t,r)];case 7:e=n.sent(),n.label=8;case 8:return e?[3,10]:[4,U(\"-webkit-mask-image\",t,r)];case 9:n.sent(),n.label=10;case 10:return[2]}}))}))}function O(t,r){return e(this,void 0,void 0,(function(){var e,i,o;return n(this,(function(n){switch(n.label){case 0:return(e=p(t,HTMLImageElement))&&!E(t.src)||p(t,SVGImageElement)&&!E(t.href.baseVal)?[4,R(i=e?t.src:t.href.baseVal,S(i),r)]:[2];case 1:return o=n.sent(),[4,new Promise((function(n,i){t.onload=n,t.onerror=r.onImageErrorHandler?function(){for(var t=[],e=0;e<arguments.length;e++)t[e]=arguments[e];try{n(r.onImageErrorHandler.apply(r,t))}catch(t){i(t)}}:i;var u=t;u.decode&&(u.decode=n),\"lazy\"===u.loading&&(u.loading=\"eager\"),e?(t.srcset=\"\",t.src=o):t.href.baseVal=o}))];case 2:return n.sent(),[2]}}))}))}function B(t,r){return e(this,void 0,void 0,(function(){var e,i;return n(this,(function(n){switch(n.label){case 0:return e=o(t.childNodes),i=e.map((function(t){return z(t,r)})),[4,Promise.all(i).then((function(){return t}))];case 1:return n.sent(),[2]}}))}))}function z(t,r){return e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:return p(t,Element)?[4,j(t,r)]:[3,4];case 1:return e.sent(),[4,O(t,r)];case 2:return e.sent(),[4,B(t,r)];case 3:e.sent(),e.label=4;case 4:return[2]}}))}))}var W={};function $(t){return e(this,void 0,void 0,(function(){var e,r;return n(this,(function(n){switch(n.label){case 0:return null!=(e=W[t])?[2,e]:[4,fetch(t)];case 1:return[4,n.sent().text()];case 2:return r=n.sent(),e={url:t,cssText:r},W[t]=e,[2,e]}}))}))}function G(t,r){return e(this,void 0,void 0,(function(){var i,o,u,c,a=this;return n(this,(function(s){return i=t.cssText,o=/url\\([\"']?([^\"')]+)[\"']?\\)/g,u=i.match(/url\\([^)]+\\)/g)||[],c=u.map((function(u){return e(a,void 0,void 0,(function(){var e;return n(this,(function(n){return(e=u.replace(o,\"$1\")).startsWith(\"https://\")||(e=new URL(e,t.url).href),[2,C(e,r.fetchRequestInit,(function(t){var e=t.result;return i=i.replace(u,\"url(\".concat(e,\")\")),[u,e]}))]}))}))})),[2,Promise.all(c).then((function(){return i}))]}))}))}function _(t){if(null==t)return[];for(var e=[],n=t.replace(/(\\/\\*[\\s\\S]*?\\*\\/)/gi,\"\"),r=new RegExp(\"((@.*?keyframes [\\\\s\\\\S]*?){([\\\\s\\\\S]*?}\\\\s*?)})\",\"gi\");;){if(null===(u=r.exec(n)))break;e.push(u[0])}n=n.replace(r,\"\");for(var i=/@import[\\s\\S]*?url\\([^)]*\\)[\\s\\S]*?;/gi,o=new RegExp(\"((\\\\s*?(?:\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\/)?\\\\s*?@media[\\\\s\\\\S]*?){([\\\\s\\\\S]*?)}\\\\s*?})|(([\\\\s\\\\S]*?){([\\\\s\\\\S]*?)})\",\"gi\");;){var u;if(null===(u=i.exec(n))){if(null===(u=o.exec(n)))break;i.lastIndex=o.lastIndex}else o.lastIndex=i.lastIndex;e.push(u[0])}return e}function J(t,r){return e(this,void 0,void 0,(function(){var e,i;return n(this,(function(n){return e=[],i=[],t.forEach((function(e){if(\"cssRules\"in e)try{o(e.cssRules||[]).forEach((function(t,n){if(t.type===CSSRule.IMPORT_RULE){var o=n+1,u=$(t.href).then((function(t){return G(t,r)})).then((function(t){return _(t).forEach((function(t){try{e.insertRule(t,t.startsWith(\"@import\")?o+=1:e.cssRules.length)}catch(e){console.error(\"Error inserting rule from remote css\",{rule:t,error:e})}}))})).catch((function(t){console.error(\"Error loading remote css\",t.toString())}));i.push(u)}}))}catch(o){var n=t.find((function(t){return null==t.href}))||document.styleSheets[0];null!=e.href&&i.push($(e.href).then((function(t){return G(t,r)})).then((function(t){return _(t).forEach((function(t){n.insertRule(t,n.cssRules.length)}))})).catch((function(t){console.error(\"Error loading remote stylesheet\",t)}))),console.error(\"Error inlining remote css file\",o)}})),[2,Promise.all(i).then((function(){return t.forEach((function(t){if(\"cssRules\"in t)try{o(t.cssRules||[]).forEach((function(t){e.push(t)}))}catch(e){console.error(\"Error while reading CSS rules from \".concat(t.href),e)}})),e}))]}))}))}function Q(t){return t.filter((function(t){return t.type===CSSRule.FONT_FACE_RULE})).filter((function(t){return V(t.style.getPropertyValue(\"src\"))}))}function X(t,r){return e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:if(null==t.ownerDocument)throw new Error(\"Provided element is not within a Document\");return[4,J(o(t.ownerDocument.styleSheets),r)];case 1:return[2,Q(e.sent())]}}))}))}function K(t){return t.trim().replace(/[\"']/g,\"\")}function Y(t,r){return e(this,void 0,void 0,(function(){var e,i;return n(this,(function(n){switch(n.label){case 0:return[4,X(t,r)];case 1:return e=n.sent(),i=function(t){var e=new Set;return function t(n){(n.style.fontFamily||getComputedStyle(n).fontFamily).split(\",\").forEach((function(t){e.add(K(t))})),Array.from(n.children).forEach((function(e){e instanceof HTMLElement&&t(e)}))}(t),e}(t),[4,Promise.all(e.filter((function(t){return i.has(K(t.style.fontFamily))})).map((function(t){var e=t.parentStyleSheet?t.parentStyleSheet.href:null;return q(t.cssText,e,r)})))];case 2:return[2,n.sent().join(\"\\n\")]}}))}))}function Z(t,r){return e(this,void 0,void 0,(function(){var e,i,o,u,c;return n(this,(function(n){switch(n.label){case 0:return null==r.fontEmbedCSS?[3,1]:(i=r.fontEmbedCSS,[3,5]);case 1:return r.skipFonts?(o=null,[3,4]):[3,2];case 2:return[4,Y(t,r)];case 3:o=n.sent(),n.label=4;case 4:i=o,n.label=5;case 5:return(e=i)&&(u=document.createElement(\"style\"),c=document.createTextNode(e),u.appendChild(c),t.firstChild?t.insertBefore(u,t.firstChild):t.appendChild(u)),[2]}}))}))}function tt(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){var e,i,o,u;return n(this,(function(n){switch(n.label){case 0:return e=s(t,r),i=e.width,o=e.height,[4,I(t,r,!0)];case 1:return[4,Z(u=n.sent(),r)];case 2:return n.sent(),[4,z(u,r)];case 3:return n.sent(),function(t,e){var n=t.style;e.backgroundColor&&(n.backgroundColor=e.backgroundColor),e.width&&(n.width=\"\".concat(e.width,\"px\")),e.height&&(n.height=\"\".concat(e.height,\"px\"));var r=e.style;null!=r&&Object.keys(r).forEach((function(t){n[t]=r[t]}))}(u,r),[4,v(u,i,o)];case 4:return[2,n.sent()]}}))}))}function et(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){var e,i,o,u,c,a,f,d,v;return n(this,(function(n){switch(n.label){case 0:return e=s(t,r),i=e.width,o=e.height,[4,tt(t,r)];case 1:return[4,h(n.sent())];case 2:return u=n.sent(),c=document.createElement(\"canvas\"),a=c.getContext(\"2d\"),f=r.pixelRatio||function(){var t,e;try{e=process}catch(t){}var n=e&&e.env?e.env.devicePixelRatio:null;return n&&(t=parseInt(n,10),Number.isNaN(t)&&(t=1)),t||window.devicePixelRatio||1}(),d=r.canvasWidth||i,v=r.canvasHeight||o,c.width=d*f,c.height=v*f,r.skipAutoScale||function(t){(t.width>l||t.height>l)&&(t.width>l&&t.height>l?t.width>t.height?(t.height*=l/t.width,t.width=l):(t.width*=l/t.height,t.height=l):t.width>l?(t.height*=l/t.width,t.width=l):(t.width*=l/t.height,t.height=l))}(c),c.style.width=\"\".concat(d),c.style.height=\"\".concat(v),r.backgroundColor&&(a.fillStyle=r.backgroundColor,a.fillRect(0,0,c.width,c.height)),a.drawImage(u,0,0,c.width,c.height),[2,c]}}))}))}t.getFontEmbedCSS=function(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){return n(this,(function(e){return[2,Y(t,r)]}))}))},t.toBlob=function(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:return[4,et(t,r)];case 1:return[4,f(e.sent())];case 2:return[2,e.sent()]}}))}))},t.toCanvas=et,t.toJpeg=function(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:return[4,et(t,r)];case 1:return[2,e.sent().toDataURL(\"image/jpeg\",r.quality||1)]}}))}))},t.toPixelData=function(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){var e,i,o,u;return n(this,(function(n){switch(n.label){case 0:return e=s(t,r),i=e.width,o=e.height,[4,et(t,r)];case 1:return u=n.sent(),[2,u.getContext(\"2d\").getImageData(0,0,i,o).data]}}))}))},t.toPng=function(t,r){return void 0===r&&(r={}),e(this,void 0,void 0,(function(){return n(this,(function(e){switch(e.label){case 0:return[4,et(t,r)];case 1:return[2,e.sent().toDataURL()]}}))}))},t.toSvg=tt}));\n";

  const content = document.getElementById("content");
  const SNAPSHOT_STEPS = {
    start: 0, lib: 0.03, load: 0.08, fonts: 0.12, images: 0.16,
    raf: 0.2, webgl: 0.22, tocanvas: 0.25, done: 1,
  };
  const SNAPSHOT_LABELS = {
    start: "starting", lib: "loading serializer", load: "waiting for island",
    fonts: "waiting for fonts", images: "waiting for images", raf: "rendering",
    webgl: "capturing WebGL", tocanvas: "rasterising", done: "done",
  };
  let busy = false;
  let captureIndex = 0;
  let captureTotal = 1;
  let lastStep = 0;

  function slug(value) {
    return String(value || "document").trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "document";
  }

  function stamp() {
    const d = new Date();
    const two = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  }

  function download(html, name) {
    const url = URL.createObjectURL(new Blob([html], {type: "text/html"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function syncPrintPage() {
    const cs = getComputedStyle(document.documentElement);
    const width = cs.getPropertyValue("--sheet-w").trim() || "8.5in";
    const height = cs.getPropertyValue("--sheet-h").trim() || "11in";
    const margin = cs.getPropertyValue("--pad").trim() || "0.9in";
    let style = document.getElementById("print-page");
    if (!style) {
      style = document.createElement("style");
      style.id = "print-page";
      document.head.append(style);
    }
    style.textContent = `@page { size: ${width} ${height}; margin: ${margin}; }`;
  }

  function waitForImages(doc, timeout = 3000) {
    const pending = [...doc.images].filter((img) => !img.complete).map((img) => new Promise((resolve) => {
      img.addEventListener("load", resolve, {once: true});
      img.addEventListener("error", resolve, {once: true});
    }));
    return pending.length
      ? Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeout))])
      : Promise.resolve();
  }

  function escapeXml(value) {
    return String(value || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function placeholder(caption) {
    const safe = escapeXml(String(caption || "").slice(0, 80));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">`
      + `<rect width="100%" height="100%" fill="#f3f4f6"/>`
      + `<text x="50%" y="50%" text-anchor="middle" fill="#b3261e" `
      + `font-family="system-ui" font-size="20">Figure could not be captured</text>`
      + (safe ? `<text x="50%" y="56%" text-anchor="middle" fill="#6b7280" `
        + `font-family="system-ui" font-size="13">${safe}</text>` : "")
      + `</svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  const FIGURE_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
    "image/gif": "gif", "image/svg+xml": "svg"};
  const mimeOf = (dataUrl) => /^data:([^;,]+)/.exec(dataUrl || "")?.[1] || "image/png";
  /* One naming rule, shared by the HTML that references a figure and the files a caller
     has to put beside it. Flat on purpose: pandoc's wasm build has no directories, so a
     name that works there works everywhere. */
  const figureFile = (index, dataUrl) =>
    `fig-${String(index + 1).padStart(2, "0")}.${FIGURE_EXT[mimeOf(dataUrl)] || "png"}`;

  /* The bytes for `media: "files"`. A data URL is right for one self-contained file and
     wrong elsewhere: LaTeX drops it, Typst inlines every byte as a number, Markdown
     base64s the prose. */
  function figureFiles(captures) {
    return (captures || []).flatMap((capture, i) => capture?.ok && capture.dataUrl
      ? [{name: figureFile(i, capture.dataUrl), mime: mimeOf(capture.dataUrl), dataUrl: capture.dataUrl}]
      : []);
  }

  function buildStatic(captures, {media = "data-uri"} = {}) {
    const clone = document.documentElement.cloneNode(true);
    const figures = [...clone.querySelectorAll("#content figure.figure")];
    const byId = new Map(captures.map((c) => [c.id, c]));

    figures.forEach((figure, i) => {
      const capture = captures[i] || byId.get(figure.dataset.figureId) || null;
      const frame = figure.querySelector(".figure-frame");
      const caption = (figure.querySelector("figcaption")?.textContent || "").trim();
      const captured = Boolean(capture && capture.ok && capture.dataUrl);
      const img = document.createElement("img");
      img.alt = caption;
      img.src = captured
        ? (media === "files" ? figureFile(i, capture.dataUrl) : capture.dataUrl)
        : placeholder(caption);
      img.style.cssText = "display:block;width:100%;height:100%;object-fit:contain";
      /* The authored width (`data-w`, `data-scale` before 0.6) is otherwise lost to the
         frame's CSS. `width` is the one attribute pandoc, a printer and a browser read. */
      const width = Number(figure.dataset.w ?? figure.dataset.scale);
      if (Number.isFinite(width) && width > 0 && width <= 1) {
        img.setAttribute("width", `${Math.round(width * 100)}%`);
      }
      if (frame) {
        frame.replaceChildren(img);
        frame.removeAttribute("data-runtime");
      }
      figure.removeAttribute("data-selected");
      figure.removeAttribute("data-mounted");
      /* The marker is the truth, so it travels: a caller that must not ship a placeholder
         can refuse the file rather than guess from a red image. */
      if (captured) figure.removeAttribute("data-missing");
      else figure.setAttribute("data-missing", "");
      figure.setAttribute("contenteditable", "false");
      figure.querySelector("figcaption")?.setAttribute("contenteditable", "false");
    });

    clone.querySelectorAll("script").forEach((n) => n.remove());
    /* Chrome, by id: the ribbon and the viewer bar are both chrome, and a static document
       carries neither. `index.html` holds every mode's chrome at once, which is how a missing
       entry here shows up as a viewer bar printed into an exported editor.

       The second sweep is the part this file got wrong (lab/016): the page furniture and
       anything the session *built* were never removed, so a `.docx` carried `#sheets`'
       folios and any `[data-runtime="ephemeral"]` node that happened to live inside
       `#content`. The rule is `session.strip()`'s — one list, three callers (a save, a print,
       this export) — which is why the selectors are the same ones, attribute for attribute.
       Two deliberate exceptions: `.page-spacer` stays, because an older live document (or a
       hand-edited file) can still carry one and the print stylesheet turns it into a page
       break (`.page-spacer + *`); `<script>` is already gone, so `#comments` cannot print.
       TODO(v0.9.2): the margin model no longer creates a spacer, so this exception, the
       `.page-spacer + *` print rule and the Lua filter's spacer branch can go once no
       pre-margin document is in circulation. */
    clone.querySelectorAll("#app-toolbar,#doc-bar,#statusline,#bubble,#blockhandle,#figure-tools,#probe,dialog").forEach((n) => n.remove());
    clone.querySelectorAll("#sheets > *, [data-emoji-menu], [data-menu-panel], [data-plugin-ui], [data-runtime='ephemeral']").forEach((n) => n.remove());

    /* A fragment is a page break, not a paragraph. Unwrap it so pandoc, a printer and a
       reader see the one paragraph the author wrote (lab/016 §9: two `<p>`s change the
       `.docx`; one `<p>` with a block span does not, once the span is gone).

       TODO(fragments): a cut *inside* a paragraph has no page-start block, so unwrapping
       here loses its break in the static document and the .docx. The margin marker below
       only covers whole-block page starts. Decide between an inline RawInline break (docx
       openxml) and keeping the paragraph whole; both need a print/PDF assertion. */
    clone.querySelectorAll("[data-frag]").forEach((frag) => {
      /* A cut inside a paragraph has no page-start block to hang a break on. Leave an
         empty inline marker at the boundary (pandoc's HTML reader keeps a Span's class)
         and unwrap the fragment; the filter turns the marker into the target's break so
         the paragraph stays one paragraph. */
      const marker = clone.ownerDocument.createElement("span");
      marker.className = "page-break-inline";
      frag.parentNode.insertBefore(marker, frag);
      while (frag.firstChild) frag.parentNode.insertBefore(frag.firstChild, frag);
      frag.remove();
    });
    /* The gap was layout, not content. A page start becomes an empty marker Div for
       pandoc — the one block element whose class survives the HTML reader — and the
       attribute goes away, so print and pandoc cannot both break the same page. The
       marker is invisible: no text, and the print rule carries the break. */
    clone.querySelectorAll("[data-page-start]").forEach((node) => {
      const marker = clone.ownerDocument.createElement("div");
      marker.className = "page-break";
      node.parentNode.insertBefore(marker, node);
      node.removeAttribute("data-page-start");
      node.style.marginBlockStart = "";
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });
    clone.querySelector('body > svg[width="0"]')?.remove();
    clone.querySelector("#content")?.removeAttribute("contenteditable");
    clone.querySelector("#content")?.removeAttribute("spellcheck");

    const title = (document.querySelector("[data-title]")?.value || "document").trim();
    clone.querySelector("title").textContent = title;

    const cs = getComputedStyle(document.documentElement);
    const sheetW = cs.getPropertyValue("--sheet-w").trim() || "8.5in";
    const sheetH = cs.getPropertyValue("--sheet-h").trim() || "11in";
    const pad = cs.getPropertyValue("--pad").trim() || "0.9in";

    const style = document.createElement("style");
    style.textContent = `
          html, body { height: auto; }
          body { display: block; min-height: 100dvh; overflow: auto; background: #e0e0e0; }
          #viewport { overflow: visible; height: auto; }
          #content { outline: none; }

          @media print {
            body { display: block; height: auto; overflow: visible; background: #fff; }
            #viewport { overflow: visible; }
            #stage {
              zoom: 1;
              padding-block: 0;
              /* The @page margin is the padding; a fixed 8.5in stage inside a 6.7in
                 printable box is scaled down by the printer. Fill the page content box. */
              width: auto;
              height: auto !important;
              min-height: 0 !important;
            }
            #sheets { display: none !important; }
            .page-spacer { display: none !important; }
            .page-spacer + * { break-before: page; }
            .page-break { break-before: page; }
            [data-page-start] { margin-block-start: 0 !important; break-before: page; }
            [data-frag] { margin-block-start: 0 !important; }
            /* An inline break-before is ignored by Chromium's paginator (measured: it
               stays one page). The empty marker is a block box inside the paragraph, so the
               break lands there; zero height keeps it from adding a line. */
            .page-break-inline {
              display: block;
              height: 0;
              margin: 0;
              line-height: 0;
              break-before: page;
            }
            #content { max-width: none; min-height: 0; }
            #content > * { break-inside: avoid; }
            /* A paragraph with a page break inside it is the one block a page break may
               enter. The :has() selector covers both a live fragment and the inline marker. */
            #content > *:has([data-frag], .page-break-inline) { break-inside: auto; }
            figure.figure { break-inside: avoid; }
            @page { size: ${sheetW} ${sheetH}; margin: ${pad}; }
            @page:right {
              @bottom-right {
                content: counter(page) " / " counter(pages);
                font: 500 8pt/1 system-ui, -apple-system, sans-serif;
                color: #9aa1ab;
              }
            }
            @page:left {
              @bottom-left {
                content: counter(page) " / " counter(pages);
                font: 500 8pt/1 system-ui, -apple-system, sans-serif;
                color: #9aa1ab;
              }
            }
          }
        `;
    clone.querySelector("head")?.append(style);

    return "<!doctype html>\n" + clone.outerHTML;
  }

  function validateStatic(html, {media = "data-uri"} = {}) {
    const problems = [];
    if (!html.startsWith("<!doctype html>")) problems.push("missing doctype");
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.querySelectorAll("script").length) problems.push("a script leaked");
    if (doc.querySelector("#content iframe")) problems.push("an iframe leaked");
    if (doc.querySelector('[src^="blob:"], [href^="blob:"]')) problems.push("a blob: URL leaked");
    if (doc.querySelector("[data-frag]")) problems.push("a pagination fragment leaked");
    if ([...doc.querySelectorAll(".page-break-inline")].some((marker) => marker.textContent.length)) {
      problems.push("a page-break marker carried text");
    }
    /* `[data-page-start]` deliberately survives: the static print rules break there. Its
       margin does not (and must not), but only the margin on *that* node is pagination's. */
    if ([...doc.querySelectorAll("[data-page-start]")]
      .some((node) => /margin-block-start/i.test(node.getAttribute("style") || ""))) {
      problems.push("a page gap reached the static document");
    }
    const figures = [...doc.querySelectorAll("#content figure.figure")];
    figures.forEach((figure, i) => {
      const img = figure.querySelector(".figure-frame img");
      /* A placeholder is a card, not a figure: report it so a `fail` caller can refuse. */
      if (figure.hasAttribute("data-missing")) {
        problems.push(`figure ${i + 1} has no captured source`);
      }
      if (!img) problems.push(`figure ${i + 1} has no image`);
      else if (media === "files") {
        if (!/^fig-\d{2}\.(png|jpg|webp|gif|svg)$/.test(img.getAttribute("src") || "")) {
          problems.push(`figure ${i + 1} image is not a figure file`);
        }
      } else if (!/^data:image\//.test(img.getAttribute("src") || "")) {
        problems.push(`figure ${i + 1} image is not a data URL`);
      }
    });
    return problems;
  }

  function progressLabel(step, ms) {
    const time = ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)} s` : ms ? ` · ${Math.round(ms)} ms` : "";
    return `Figure ${captureIndex} of ${captureTotal} · ${SNAPSHOT_LABELS[step] || step}${time}`;
  }

  function startProgress(total) {
    captureIndex = 0;
    captureTotal = Math.max(1, total);
    lastStep = 0;
    progress.open({
      heading: "Preparing export",
      total,
      onCancel: () => {
        window.__exportAbort = true;
        progress.setCancel("Finishing current figure…", true);
        progress.setText("Cancelling after this figure…");
      },
    });
  }

  function captureProgress(p) {
    if (!progress.isOpen) return;
    if (p.phase === "mount") {
      captureIndex = p.index;
      lastStep = 0;
      progress.update((p.index - 1) / p.total,
        `Figure ${p.index} of ${p.total} · mounting`);
      return;
    }
    if (p.phase === "done") {
      progress.update(1, "Done");
      return;
    }
    if (p.phase !== "capture") return;
    const stepFrac = SNAPSHOT_STEPS[p.step] ?? lastStep / 100;
    lastStep = Math.round(stepFrac * 100);
    progress.update((p.index - 1 + stepFrac) / p.total, progressLabel(p.step, p.ms));
  }

  /* The target decides the format: WebP for the HTML export, never for Word 2013. And the
     target decides whether a figure's **own** vector output may stand in for a raster: an
     HTML page and a print job carry SVG, so they ask for it first; a `.docx` writer's image
     path may not, so `materialize()` asks for nothing unless its caller says so. */
  async function capture({format = "webp", formats = ["svg"]} = {}) {
    const controller = new AbortController();
    window.__exportAbort = false;
    const total = content.querySelectorAll("figure.figure").length;
    startProgress(total);
    try {
      const captures = await figures.captureAll({
        lib: SNAPSHOT_LIB,
        /* The same bytes, delivered as code rather than a string: a sealed island cannot
           eval, and the serializer is ours to ship either way. */
        serializer: SNAPSHOT_LIB,
        formats,
        pixelRatio: 2,
        format,
        quality: 0.9,
        signal: controller.signal,
        onProgress: (p) => {
          if (window.__exportAbort && !controller.signal.aborted) {
            controller.abort();
          }
          captureProgress(p);
        },
      });
      return {captures, aborted: controller.signal.aborted || window.__exportAbort};
    } finally {
      progress.close();
    }
  }

  async function captureAndBuild({format = "webp", media = "data-uri"} = {}) {
    const {captures, aborted} = await capture({format});
    if (aborted) return null;
    const html = buildStatic(captures, {media});
    const problems = validateStatic(html, {media});
    if (problems.length) throw new Error(problems.join("; "));
    return {html, captures, files: media === "files" ? figureFiles(captures) : []};
  }

  /* A plugin's way in: the captured document, and nothing else. It runs the host's own
     progress dialog and honour the same abort, and it *reports* problems instead of
     throwing — whether a placeholder is fatal belongs to the caller's contract
     (`onMissing: fail`), not to the materializer. One capability, one function: a plugin
     may be an exporter; it may not become the export menu. */
  async function materialize({format = "png", media = "files", formats = []} = {}) {
    if (busy) throw new Error("an export is already running");
    busy = true;
    try {
      const {captures, aborted} = await capture({format, formats});
      if (aborted) return null;
      const html = buildStatic(captures, {media});
      return {
        html,
        files: media === "files" ? figureFiles(captures) : [],
        problems: validateStatic(html, {media}),
      };
    } finally {
      busy = false;
    }
  }

  if (registry && typeof registry.provide === "function") {
    registry.provide("materialize", {build: materialize});
  }

  async function exportStatic() {
    const result = await captureAndBuild();
    if (!result) return;
    const title = (document.querySelector("[data-title]")?.value || "document").trim();
    download(result.html, `${slug(title)}-static-${stamp()}.html`);
  }

  function printLive() {
    syncPrintPage();
    console.info("The browser print dialog controls headers and footers; turn them off there for clean pages.");
    window.print();
  }

  async function printCaptured() {
    let win = null;
    try {
      win = window.open("", "_blank");
    } catch (err) {
      win = null;
    }
    if (win) {
      win.document.write(`<!doctype html><title>Preparing print…</title>`
        + `<div style="font:14px system-ui;padding:24px">`
        + `<p>Preparing figures for print…</p>`
        + `<p style="color:#6b7280">If the print dialog adds headers and footers, turn them off there.</p>`
        + `</div>`);
    }
    try {
      const result = await captureAndBuild();
      if (!result) {
        if (win) win.close();
        return;
      }
      if (!win) {
        const title = (document.querySelector("[data-title]")?.value || "document").trim();
        download(result.html, `${slug(title)}-static-${stamp()}.html`);
        return;
      }
      win.document.open();
      win.document.write(result.html);
      win.document.close();
      await waitForImages(win.document, 4000);
      if (!win.closed) {
        win.focus();
        win.print();
      }
    } catch (err) {
      console.error("Print export failed:", err);
      if (win && !win.closed) win.close();
      progress.open({
        heading: "Export failed",
        total: 1,
        onCancel: () => progress.close(),
      });
      progress.setCancel("Close");
      progress.setText(String(err && err.message || err));
    }
  }

  async function begin(kind) {
    if (busy) return;
    /* A file destination, always: "Save as… → HTML → Interactive" is the way to get a copy
       you can send, so it must not be routed into the library sink by a document that
       happens to name one. `to: "file"` is also what keeps the copy's assets the author's
       choice — a hosted document saves `slim`, which needs the network to open. */
    if (kind === "html-interactive") {toolbar.save({to: "file"}); return;}
    if (kind === "print-live") {printLive(); return;}
    busy = true;
    const buttons = [...document.querySelectorAll("[data-export]")];
    buttons.forEach((b) => {b.disabled = true;});
    try {
      if (kind === "html-static") await exportStatic();
      else if (kind === "print-captured") await printCaptured();
    } catch (err) {
      console.error("Export failed:", err);
      progress.open({
        heading: "Export failed",
        total: 1,
        onCancel: () => progress.close(),
      });
      progress.setCancel("Close");
      progress.setText(String(err && err.message || err));
    } finally {
      busy = false;
      buttons.forEach((b) => {b.disabled = false;});
    }
  }

  window.addEventListener("beforeprint", syncPrintPage);

  return {begin, capture, captureAndBuild, materialize, buildStatic, validateStatic, figureFiles, download,
    syncPrintPage, printLive, printCaptured};
}

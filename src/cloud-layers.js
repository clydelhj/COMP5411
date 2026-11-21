/* Procedural cloud color and coverage for the directional sky atlas. */
(function registerBackgroundClouds(global) {
  'use strict';

  const backgroundShader = /* glsl */`
    float skyCloudHash(vec2 cell) {
      vec3 p=fract(cell.xyx*vec3(0.1031,0.1030,0.0973));
      p+=dot(p,p.yzx+33.33);
      return fract((p.x+p.y)*p.z);
    }
    float skyCloudNoise(vec2 p) {
      vec2 cell=floor(p), f=fract(p);
      f=f*f*(3.0-2.0*f);
      return mix(mix(skyCloudHash(cell),skyCloudHash(cell+vec2(1.0,0.0)),f.x),
                 mix(skyCloudHash(cell+vec2(0.0,1.0)),skyCloudHash(cell+1.0),f.x),f.y);
    }
    vec4 skyBackgroundClouds(vec3 direction,float time,float weather,float daylight,float twilight,vec3 sunDirection) {
      // Use viewing direction only. The soft horizon mask keeps distant ridgelines legible.
      float horizon=smoothstep(0.015,0.20,direction.y);
      if(horizon==0.0) return vec4(0.0);
      vec2 p=direction.xz/(0.30+direction.y);
      p=p*vec2(3.0,4.1)+vec2(37.3,19.8)+vec2(0.009,0.004)*time;
      p+=0.58*vec2(skyCloudNoise(p*0.71),skyCloudNoise(p*0.63+13.7));
      const mat2 turn=mat2(1.63,1.12,-1.12,1.63);
      float field=0.53*skyCloudNoise(p);
      p=turn*p+11.3;
      field+=0.27*skyCloudNoise(p);
      p=turn*p+23.7;
      field+=0.13*skyCloudNoise(p);
      field+=0.07*skyCloudNoise(turn*p);

      float threshold=mix(0.59,0.31,weather);
      float alpha=smoothstep(threshold,threshold+0.13,field)*horizon*mix(0.88,0.97,weather);
      float depth=smoothstep(threshold,threshold+0.23,field);
      float towardSun=pow(max(dot(direction,sunDirection),0.0),5.0);
      vec3 lit=mix(vec3(0.91,0.94,0.97),vec3(0.48,0.53,0.60),weather);
      vec3 shade=mix(vec3(0.48,0.56,0.66),vec3(0.19,0.25,0.33),weather);
      vec3 color=mix(lit,shade,depth*(0.82-0.25*towardSun));
      vec3 sunset=mix(vec3(0.42,0.29,0.36),vec3(1.03,0.63,0.40),towardSun*(1.0-0.5*depth));
      color=mix(color,sunset,twilight*(1.0-0.48*weather));
      color=mix(vec3(0.006,0.009,0.019),color,daylight);
      return vec4(color,alpha);
    }
  `;
  global.NotoCloudLayers = { backgroundShader };
})(window);

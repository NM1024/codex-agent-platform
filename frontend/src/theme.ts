import type {ThemeConfig} from 'antd';

// Shared control density and interaction states. Application layout stays in CSS.
const primary='#345e4f';
const focus='0 0 0 3px rgb(52 94 79 / 12%)';
export const consoleTheme:ThemeConfig={
  token:{
    colorPrimary:primary,colorInfo:'#426aa6',colorSuccess:'#287751',colorWarning:'#ad741d',colorError:'#bd3f50',
    colorText:'#24312c',colorTextSecondary:'#67766e',colorTextTertiary:'#7d8983',
    colorBgLayout:'#f3f6f8',colorBgContainer:'#ffffff',colorBorder:'#d8e1dc',colorBorderSecondary:'#e8eeea',
    colorBgContainerDisabled:'#f1f4f2',colorTextDisabled:'#99a59e',
    borderRadius:8,borderRadiusSM:6,borderRadiusLG:12,
    controlHeight:36,controlHeightSM:32,controlHeightLG:40,
    fontSize:14,fontSizeSM:12,fontSizeLG:16,lineHeight:22/14,
    fontFamily:'Inter, "Segoe UI", "Microsoft YaHei", sans-serif',
    controlOutline:'rgb(52 94 79 / 12%)',controlOutlineWidth:3,
    boxShadowSecondary:'0 8px 32px rgb(28 48 38 / 8%)',
  },
  components:{
    Button:{fontWeight:500,contentFontSize:14,contentFontSizeSM:12,contentFontSizeLG:16,iconGap:8,defaultShadow:'0 1px 2px rgb(28 48 38 / 3%)',primaryShadow:'0 2px 4px rgb(52 94 79 / 12%)',dangerShadow:'none',defaultColor:'#42564b',defaultBorderColor:'#d8e1dc',defaultHoverColor:primary,defaultHoverBorderColor:'#86a594',defaultHoverBg:'#f1f7f3',defaultActiveBg:'#e8f1ec',paddingInline:14,paddingInlineSM:10},
    Input:{paddingBlock:6,paddingBlockSM:5,paddingInline:12,activeBorderColor:primary,hoverBorderColor:'#86a594',activeShadow:focus},
    InputNumber:{paddingBlock:6,paddingBlockSM:5,paddingInline:12,activeBorderColor:primary,hoverBorderColor:'#86a594',activeShadow:focus},
    Select:{activeBorderColor:primary,hoverBorderColor:'#86a594',activeOutlineColor:'rgb(52 94 79 / 12%)',optionHeight:36},
    Card:{headerHeight:52,headerFontSize:16,bodyPadding:24,headerPadding:24},
    Table:{headerBg:'#f5f8f6',headerColor:'#516258',headerSplitColor:'#e4ebe6',rowHoverBg:'#f6faf7',borderColor:'#e8eeea',cellPaddingBlock:16,cellPaddingInline:16},
    Tag:{defaultBg:'#f2f5f3',defaultColor:'#607168'},
    Tabs:{itemColor:'#6c7c72',itemSelectedColor:primary,itemHoverColor:primary,inkBarColor:primary},
    Modal:{titleFontSize:18},
  },
};
